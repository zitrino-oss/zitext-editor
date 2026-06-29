import { invoke } from '@tauri-apps/api/core';

interface WatchedFile {
    path: string;
    lastModified: number;
    // A path can back more than one tab (e.g. the same file opened in both
    // split panes). Track every interested callback so notifications aren't
    // silently lost when a second watcher registers for the same path.
    callbacks: Set<() => void>;
}

class FileWatcherService {
    private watchedFiles: Map<string, WatchedFile> = new Map();
    // Paths the app currently wants watched. Used to guard the async
    // getFileModTime() callback: if unwatch() ran before the mod-time resolves,
    // the path is no longer wanted and must not be (re)inserted.
    private wanted: Set<string> = new Set();
    private pollInterval: number = 2000; // Check every 2 seconds
    private intervalId: number | null = null;

    /**
     * Start watching a file for changes
     */
    watch(path: string, onChanged: () => void): void {
        this.wanted.add(path);

        // Already watching this path — just add the callback.
        const existing = this.watchedFiles.get(path);
        if (existing) {
            existing.callbacks.add(onChanged);
            return;
        }

        // New path — fetch the initial modification time, then install (unless
        // it was unwatched while the async read was in flight).
        this.getFileModTime(path).then(modTime => {
            if (modTime === null) return;
            if (!this.wanted.has(path)) return; // unwatched before resolve — don't resurrect

            const entry = this.watchedFiles.get(path);
            if (entry) {
                // Another watch() for the same path landed first.
                entry.callbacks.add(onChanged);
            } else {
                this.watchedFiles.set(path, {
                    path,
                    lastModified: modTime,
                    callbacks: new Set([onChanged]),
                });
            }

            // Start polling if not already started
            if (this.intervalId === null) {
                this.startPolling();
            }
        }).catch(err => {
            console.error('Failed to watch file:', path, err);
        });
    }

    /**
     * Stop watching a file (removes all callbacks registered for the path)
     */
    unwatch(path: string): void {
        this.wanted.delete(path);
        this.watchedFiles.delete(path);

        // Stop polling if no files are being watched
        if (this.watchedFiles.size === 0 && this.intervalId !== null) {
            this.stopPolling();
        }
    }

    /**
     * Stop watching all files
     */
    unwatchAll(): void {
        this.wanted.clear();
        this.watchedFiles.clear();
        this.stopPolling();
    }

    /**
     * Update the last known modification time (after reload)
     */
    updateModTime(path: string, modTime: number): void {
        const watched = this.watchedFiles.get(path);
        if (watched) {
            watched.lastModified = modTime;
        }
    }

    /**
     * Get file modification time via Tauri
     */
    private async getFileModTime(path: string): Promise<number | null> {
        try {
            // Use Tauri's fs plugin to get file metadata
            const metadata = await invoke<{ modified: number }>('get_file_metadata', { path });
            return metadata.modified;
        } catch (error) {
            console.error('Failed to get file metadata:', error);
            return null;
        }
    }

    /**
     * Start polling for file changes
     */
    private startPolling(): void {
        this.intervalId = window.setInterval(() => {
            this.checkAllFiles();
        }, this.pollInterval);
    }

    /**
     * Stop polling
     */
    private stopPolling(): void {
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Check all watched files for changes (batched for performance)
     */
    private async checkAllFiles(): Promise<void> {
        const paths = Array.from(this.watchedFiles.keys());
        if (paths.length === 0) return;

        try {
            // Batched call - single IPC instead of N calls
            const metadataList = await invoke<Array<{ path: string; modified: number }>>('get_files_metadata', { paths });

            for (const metadata of metadataList) {
                const watched = this.watchedFiles.get(metadata.path);
                if (watched && metadata.modified > watched.lastModified) {
                    // File has been modified externally
                    watched.callbacks.forEach(cb => cb());
                    // Don't update lastModified here - let the reload handler do it
                }
            }
        } catch (error) {
            // Fallback to individual checks if batch fails
            console.warn('Batch metadata check failed, falling back to individual checks:', error);
            for (const [path, watched] of this.watchedFiles.entries()) {
                try {
                    const currentModTime = await this.getFileModTime(path);
                    if (currentModTime !== null && currentModTime > watched.lastModified) {
                        watched.callbacks.forEach(cb => cb());
                    }
                } catch (err) {
                    console.warn('Error checking file:', path, err);
                }
            }
        }
    }
}

// Singleton instance
export const fileWatcher = new FileWatcherService();
