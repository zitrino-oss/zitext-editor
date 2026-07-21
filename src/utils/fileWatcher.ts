import { invoke } from '@tauri-apps/api/core';

export interface FileVersion {
    modified: number;
    size: number;
    exists: boolean;
    identity: string;
}

interface WatchedFile {
    path: string;
    acceptedVersion: FileVersion;
    pendingVersion: FileVersion | null;
    callbacks: Set<() => void>;
}

const sameVersion = (left: FileVersion, right: FileVersion): boolean =>
    left.modified === right.modified
    && left.size === right.size
    && left.exists === right.exists
    && left.identity === right.identity;

class FileWatcherService {
    private watchedFiles = new Map<string, WatchedFile>();
    private wanted = new Set<string>();
    private pollInterval = 2000;
    private intervalId: number | null = null;

    watch(path: string, onChanged: () => void): void {
        this.wanted.add(path);
        const existing = this.watchedFiles.get(path);
        if (existing) {
            existing.callbacks.add(onChanged);
            return;
        }

        this.getFileVersion(path).then(version => {
            if (!version || !this.wanted.has(path)) return;
            const raced = this.watchedFiles.get(path);
            if (raced) {
                raced.callbacks.add(onChanged);
            } else {
                this.watchedFiles.set(path, {
                    path,
                    acceptedVersion: version,
                    pendingVersion: null,
                    callbacks: new Set([onChanged]),
                });
            }
            if (this.intervalId === null) this.startPolling();
        }).catch(error => {
            console.error('Failed to watch file:', path, error);
        });
    }

    unwatch(path: string): void {
        this.wanted.delete(path);
        this.watchedFiles.delete(path);
        if (this.watchedFiles.size === 0) this.stopPolling();
    }

    unwatchAll(): void {
        this.wanted.clear();
        this.watchedFiles.clear();
        this.stopPolling();
    }

    updateVersion(path: string, version: FileVersion): void {
        const watched = this.watchedFiles.get(path);
        if (watched) {
            watched.acceptedVersion = version;
            watched.pendingVersion = null;
        }
    }

    acknowledge(path: string): void {
        const watched = this.watchedFiles.get(path);
        if (watched?.pendingVersion) {
            watched.acceptedVersion = watched.pendingVersion;
            watched.pendingVersion = null;
        }
    }

    isPendingDeletion(path: string): boolean {
        return this.watchedFiles.get(path)?.pendingVersion?.exists === false;
    }

    private async getFileVersion(path: string): Promise<FileVersion | null> {
        try {
            return await invoke<FileVersion>('get_file_metadata', { path });
        } catch (error) {
            console.error('Failed to get file metadata:', error);
            return null;
        }
    }

    private startPolling(): void {
        this.intervalId = window.setInterval(() => {
            void this.checkAllFiles();
        }, this.pollInterval);
    }

    private stopPolling(): void {
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private notifyIfChanged(watched: WatchedFile, version: FileVersion): void {
        if (sameVersion(version, watched.acceptedVersion)) {
            watched.pendingVersion = null;
            return;
        }
        if (watched.pendingVersion && sameVersion(version, watched.pendingVersion)) {
            return;
        }
        watched.pendingVersion = version;
        watched.callbacks.forEach(callback => callback());
    }

    private async checkAllFiles(): Promise<void> {
        const paths = Array.from(this.watchedFiles.keys());
        if (paths.length === 0) return;

        try {
            const metadataList = await invoke<Array<FileVersion & { path: string }>>(
                'get_files_metadata',
                { paths },
            );
            for (const metadata of metadataList) {
                const watched = this.watchedFiles.get(metadata.path);
                if (watched) this.notifyIfChanged(watched, metadata);
            }
        } catch (error) {
            console.warn('Batch metadata check failed, falling back to individual checks:', error);
            for (const [path, watched] of this.watchedFiles.entries()) {
                const version = await this.getFileVersion(path);
                if (version) this.notifyIfChanged(watched, version);
            }
        }
    }
}

export const fileWatcher = new FileWatcherService();
