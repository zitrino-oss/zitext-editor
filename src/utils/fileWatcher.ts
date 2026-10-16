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
    /** One callback per owner (tab id). */
    callbacks: Map<string, () => void>;
}

const sameVersion = (left: FileVersion, right: FileVersion): boolean =>
    left.modified === right.modified
    && left.size === right.size
    && left.exists === right.exists
    && left.identity === right.identity;

/**
 * Polls watched files for external changes. A path is watched once however
 * many owners (tabs) ask for it, and stays watched until its last owner
 * unwatches it: one tab closing or moving to another path no longer silences
 * the watcher for another tab on the same file.
 */
class FileWatcherService {
    private watchedFiles = new Map<string, WatchedFile>();
    /** Owners per path, including paths whose first metadata read is pending. */
    private wanted = new Map<string, Map<string, () => void>>();
    private pollInterval = 2000;
    private intervalId: number | null = null;
    private checking = false;
    // Saves in flight per path, and a counter that orders saves and polls: a
    // poll that started before a save ended may have sampled the file while
    // ZITEXT itself was replacing it, so its result is ignored.
    private writesInFlight = new Map<string, number>();
    private writeClock = 0;
    private lastWriteAt = new Map<string, number>();

    /** Call before ZITEXT writes `path`. */
    beginWrite(path: string): void {
        this.writesInFlight.set(path, (this.writesInFlight.get(path) ?? 0) + 1);
        this.lastWriteAt.set(path, ++this.writeClock);
    }

    /** Call after the write; pass the written version when it succeeded. */
    endWrite(path: string, version?: FileVersion): void {
        if (version) this.updateVersion(path, version);
        const remaining = (this.writesInFlight.get(path) ?? 1) - 1;
        if (remaining > 0) this.writesInFlight.set(path, remaining);
        else this.writesInFlight.delete(path);
        this.lastWriteAt.set(path, ++this.writeClock);
    }

    private overlapsOwnWrite(path: string, pollStartedAt: number): boolean {
        return this.writesInFlight.has(path) || (this.lastWriteAt.get(path) ?? 0) > pollStartedAt;
    }

    watch(path: string, owner: string, onChanged: () => void): void {
        let owners = this.wanted.get(path);
        if (!owners) {
            owners = new Map();
            this.wanted.set(path, owners);
        }
        owners.set(owner, onChanged);
        const existing = this.watchedFiles.get(path);
        if (existing) {
            existing.callbacks = owners;
            return;
        }

        this.getFileVersion(path).then(version => {
            const current = this.wanted.get(path);
            if (!version || !current) return;
            if (!this.watchedFiles.has(path)) {
                this.watchedFiles.set(path, {
                    path,
                    acceptedVersion: version,
                    pendingVersion: null,
                    callbacks: current,
                });
            }
            if (this.intervalId === null) this.startPolling();
        }).catch(error => {
            console.error('Failed to watch file:', path, error);
        });
    }

    unwatch(path: string, owner: string): void {
        const owners = this.wanted.get(path);
        if (!owners) return;
        owners.delete(owner);
        if (owners.size > 0) return;
        this.wanted.delete(path);
        this.watchedFiles.delete(path);
        if (this.watchedFiles.size === 0) this.stopPolling();
    }

    /** Drops every path a closing tab watched, whatever it is called now. */
    unwatchOwner(owner: string): void {
        for (const [path, owners] of [...this.wanted]) {
            if (owners.has(owner)) this.unwatch(path, owner);
        }
    }

    unwatchAll(): void {
        this.wanted.clear();
        this.watchedFiles.clear();
        this.writesInFlight.clear();
        this.lastWriteAt.clear();
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

    // While the window is minimized or hidden, polling stops: each round
    // opens and stats every watched file, and nobody is looking. Coming back
    // checks at once, so a change made meanwhile shows up straight away.
    private readonly onVisibilityChange = (): void => {
        if (!document.hidden) void this.checkAllFiles();
    };

    private startPolling(): void {
        this.intervalId = window.setInterval(() => {
            if (!document.hidden) void this.checkAllFiles();
        }, this.pollInterval);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    private stopPolling(): void {
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
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
        // Single flight: on a slow or unreachable share one check can take
        // longer than the poll interval, and stacking more would only queue
        // more blocked filesystem calls. (A file on a share that doesn't
        // answer is skipped by the backend; the others are still checked.)
        if (this.checking) return;
        const paths = Array.from(this.watchedFiles.keys());
        if (paths.length === 0) return;
        this.checking = true;
        try {
            await this.checkPaths(paths);
        } finally {
            this.checking = false;
        }
    }

    private async checkPaths(paths: string[]): Promise<void> {
        const startedAt = this.writeClock;
        try {
            const metadataList = await invoke<Array<FileVersion & { path: string }>>(
                'get_files_metadata',
                { paths },
            );
            for (const metadata of metadataList) {
                const watched = this.watchedFiles.get(metadata.path);
                if (watched && !this.overlapsOwnWrite(metadata.path, startedAt)) this.notifyIfChanged(watched, metadata);
            }
        } catch (error) {
            console.warn('Batch metadata check failed, falling back to individual checks:', error);
            for (const [path, watched] of this.watchedFiles.entries()) {
                const version = await this.getFileVersion(path);
                if (version && !this.overlapsOwnWrite(path, startedAt)) this.notifyIfChanged(watched, version);
            }
        }
    }
}

export const fileWatcher = new FileWatcherService();
