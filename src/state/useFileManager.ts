import { useCallback, useRef, useEffect } from 'react';
import type { Tab } from '../types';
import { errorService } from '../services/ErrorService';
import {
    readFileContent,
    writeFileContent,
    openFileDialog,
    saveFileDialog,
    addRecentFile,
    rebuildNativeMenu,
    detectEOL,
} from '../utils/fileOperations';
import { detectLanguage } from '../utils/languageDetection';
import { fileWatcher } from '../utils/fileWatcher';
import { LARGE_FILE_WARNING_BYTES, BYTES_PER_MB } from '../constants';
import { startTimer, endTimer } from '../utils/perfMetrics';

/** Rejects saving a file whose chosen name is still the default "Untitled"
 *  form (e.g. "Untitled", "Untitled-3.txt"). Shared by Save and Save As. */
function isUntitledFileName(savePath: string): boolean {
    const fileName = savePath.split(/[/\\]/).pop() || '';
    const fileNameWithoutExt = fileName.replace(/\.[^.]+$/, '');
    return /^untitled(-\d+)?$/i.test(fileNameWithoutExt);
}

/**
 * useFileManager - Manages file I/O operations
 *
 * Handles opening, saving, and file dialog interactions.
 * Separated from useEditorState for better modularity.
 */
export function useFileManager(
    tabs: Tab[],
    addTab: (tab: Tab) => void,
    updateTab: (tabId: string, updates: Partial<Tab>) => void,
    findTabByPath: (path: string) => Tab | undefined,
    setActiveTabId: (id: string) => void,
    markExternallyModified: (tabId: string) => void,
    onRecentFilesChanged?: () => Promise<void> | void
) {
    const openingFiles = useRef<Set<string>>(new Set());

    // Cleanup openingFiles when tabs change to ensure the lock is released
    // only after the tab actually appears in the state.
    useEffect(() => {
        const tabPaths = new Set(tabs.map(t => t.path).filter((p): p is string => p !== null));
        for (const path of openingFiles.current) {
            if (tabPaths.has(path)) {
                openingFiles.current.delete(path);
            }
        }
    }, [tabs]);

    /**
     * Open a file from disk
     */
    const openFile = useCallback(async (
        path: string,
        cursorLine: number = 1,
        cursorColumn: number = 1,
        scrollTop: number = 0,
        scrollLeft: number = 0,
        skipMenuRebuild: boolean = false
    ): Promise<string | null> => {
        let acquired = false;
        let added = false;
        try {
            // Check if file is already open BEFORE acquiring the lock so the
            // lock is only held while we're actually reading the file from disk.
            const existingTab = findTabByPath(path);

            if (existingTab) {
                setActiveTabId(existingTab.id);
                // Apply cursor/scroll if non-default values were requested
                if (cursorLine !== 1 || cursorColumn !== 1 || scrollTop !== 0 || scrollLeft !== 0) {
                    updateTab(existingTab.id, { cursorLine, cursorColumn, scrollTop, scrollLeft });
                }
                return existingTab.id;
            }

            // Concurrency lock: prevent duplicate disk reads for the same path
            if (openingFiles.current.has(path)) {
                return null;
            }
            openingFiles.current.add(path);
            acquired = true;

            startTimer('file-open');
            const result = await readFileContent(path);

            // Warn for large files
            if (result.size > LARGE_FILE_WARNING_BYTES) {
                const sizeMB = (result.size / BYTES_PER_MB).toFixed(1);
                const fileName = path.split(/[/\\]/).pop();
                const proceed = confirm(
                    `⚠️ Large File Warning\n\n` +
                    `File: ${fileName}\n` +
                    `Size: ${sizeMB} MB\n\n` +
                    `Opening large files may impact performance.\n\n` +
                    `Do you want to continue?`
                );
                if (!proceed) return null;
            }

            const language = detectLanguage(path);
            const eol = detectEOL(result.content);

            const newTab: Tab = {
                id: `tab-${Date.now()}-${Math.random()}`,
                path,
                title: path.split(/[/\\]/).pop() || 'Untitled',
                content: result.content,
                cursorLine,
                cursorColumn,
                isDirty: false,
                language,
                isReadOnly: false,
                encoding: result.encoding,
                eol,
                scrollTop,
                scrollLeft,
                isUntitled: false,
                externallyModified: false,
                externalChangeCount: 0,
            };

            endTimer('file-open');
            addTab(newTab);
            added = true;
            await addRecentFile(path);

            // Trigger React state update for recent files if callback provided
            if (onRecentFilesChanged) {
                await onRecentFilesChanged();
            }

            // Only rebuild menu if not skipping (to avoid race conditions with menu clicks)
            if (!skipMenuRebuild) {
                await rebuildNativeMenu();
            }

            // Start watching file for external changes
            fileWatcher.watch(path, () => {
                markExternallyModified(newTab.id);
            });

            return newTab.id;
        } catch (error) {
            const msg = String(typeof error === 'string' ? error : (error instanceof Error ? error.message : error));
            // Friendly message for binary/unsupported files instead of a red error
            if (msg.includes('binary') || msg.includes('cannot display') || msg.includes('File too large')) {
                const fileName = path.split(/[\\/]/).pop() || path;
                errorService.showWarning(`"${fileName}" cannot be opened — ${msg}`);
            } else {
                console.error('[openFile] Error opening file:', path, error);
                errorService.showError('Failed to open file', error as Error);
            }
            return null;
        } finally {
            // Release the lock only if we acquired it but never committed a tab
            // (e.g. the user declined the large-file warning, or a read error).
            // On success the cleanup effect frees it once the tab lands in state,
            // which keeps concurrent opens of the same path deduped meanwhile.
            if (acquired && !added) {
                openingFiles.current.delete(path);
            }
        }
    }, [tabs, addTab, findTabByPath, setActiveTabId, updateTab, addRecentFile, onRecentFilesChanged, markExternallyModified]);

    /**
     * Open file dialog and load selected file
     */
    const openFileFromDialog = useCallback(async (): Promise<void> => {
        try {
            const path = await openFileDialog();
            // Explicitly check for null or empty string (user cancelled)
            if (path && path.trim() !== '') {
                await openFile(path);
            }
        } catch (error) {
            errorService.showError('Failed to open file', error as Error);
        }
    }, [openFile]);

    /**
     * Save file to disk
     */
    // Returns true only when the file was actually written to disk. Callers that
    // close the tab on save (e.g. the unsaved-changes dialog) MUST check this so
    // a cancelled Save-As or a write error never silently discards the content.
    const saveFile = useCallback(async (tabId: string): Promise<boolean> => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return false;

        try {
            let savePath = tab.path;

            if (!savePath) {
                // Save As for untitled files
                let defaultName = tab.title;
                if (!defaultName.includes('.')) {
                    defaultName += '.txt';
                }
                savePath = await saveFileDialog(defaultName);
                if (!savePath) return false; // User cancelled

                if (isUntitledFileName(savePath)) {
                    errorService.showError(
                        'Invalid filename',
                        new Error('Cannot save file with "Untitled" as the filename. Please choose a different name.')
                    );
                    return false;
                }
            }

            const wasUntitled = !tab.path;
            startTimer('file-save');
            await writeFileContent(savePath, tab.content);
            endTimer('file-save');

            // Update tab with new path and title
            const newTitle = savePath.split(/[/\\]/).pop() || 'Untitled';
            updateTab(tabId, {
                path: savePath,
                title: newTitle,
                isDirty: false,
                language: detectLanguage(savePath),
                isUntitled: false,
            });

            // Update file watcher:
            // • Untitled files were never watched — start watching now.
            // • Already-watched files — update the stored mod time so the next poll
            //   doesn't fire a false "externally modified" alert.
            if (wasUntitled) {
                fileWatcher.watch(savePath, () => markExternallyModified(tabId));
            } else {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    const metadata = await invoke<{ modified: number }>('get_file_metadata', { path: savePath });
                    fileWatcher.updateModTime(savePath, metadata.modified);
                } catch (err) {
                    console.warn('Failed to update file watcher mod time:', err);
                }
            }

            await addRecentFile(savePath);
            if (onRecentFilesChanged) await onRecentFilesChanged();
            await rebuildNativeMenu();
            errorService.showSuccess(`File saved: ${savePath.split(/[\\/]/).pop()}`);
            return true;
        } catch (error) {
            errorService.showError('Failed to save file', error as Error);
            return false;
        }
    }, [tabs, updateTab, markExternallyModified, onRecentFilesChanged]);

    /**
     * Save file with new name
     */
    const saveFileAs = useCallback(async (tabId: string): Promise<void> => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;

        try {
            const defaultName = tab.path
                ? tab.path.split(/[\\/]/).pop()!
                : (tab.title.includes('.') ? tab.title : tab.title + '.txt');
            const savePath = await saveFileDialog(defaultName);
            if (!savePath) return;

            if (isUntitledFileName(savePath)) {
                errorService.showError(
                    'Invalid filename',
                    new Error('Cannot save file with "Untitled" as the filename. Please choose a different name.')
                );
                return;
            }

            await writeFileContent(savePath, tab.content);

            // Update tab with new path and title
            const newTitle = savePath.split(/[/\\]/).pop() || 'Untitled';
            updateTab(tabId, {
                path: savePath,
                title: newTitle,
                isDirty: false,
                language: detectLanguage(savePath),
                isUntitled: false,
            });

            // Unwatch the old path (if any) and start watching the new path.
            if (tab.path) {
                fileWatcher.unwatch(tab.path);
            }
            fileWatcher.watch(savePath, () => markExternallyModified(tabId));

            await addRecentFile(savePath);
            if (onRecentFilesChanged) await onRecentFilesChanged();
            await rebuildNativeMenu();
            errorService.showSuccess(`File saved as: ${savePath.split(/[\\/]/).pop()}`);
        } catch (error) {
            errorService.showError('Failed to save file', error as Error);
        }
    }, [tabs, updateTab, markExternallyModified, onRecentFilesChanged]);

    /**
     * Reload file from disk (after external modification)
     */
    const reloadFileFromDisk = useCallback(async (tabId: string): Promise<void> => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab || !tab.path) return;

        try {
            const result = await readFileContent(tab.path);
            const eol = detectEOL(result.content);

            updateTab(tabId, {
                content: result.content,
                eol,
                isDirty: false,
                externallyModified: false,
            });

            // Update file watcher with new mod time
            const { invoke } = await import('@tauri-apps/api/core');
            const metadata = await invoke<{ modified: number }>('get_file_metadata', { path: tab.path });
            fileWatcher.updateModTime(tab.path, metadata.modified);
        } catch (error) {
            console.error('Failed to reload file:', error);
            throw error;
        }
    }, [tabs, updateTab]);
    /**
     * Rename a file on disk and update the tab
     */
    const renameFile = useCallback(async (tabId: string, newName: string): Promise<void> => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;

        try {
            if (!tab.path) {
                // For untitled files, just update the title
                updateTab(tabId, { title: newName });
                return;
            }

            const oldPath = tab.path;
            const pathParts = oldPath.split(/[\\/]/);
            pathParts.pop();
            const newPath = [...pathParts, newName].join(oldPath.includes('\\') ? '\\' : '/');

            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('rename_file', { oldPath, newPath });

            fileWatcher.unwatch(oldPath);
            fileWatcher.watch(newPath, () => {
                markExternallyModified(tabId);
            });

            updateTab(tabId, {
                path: newPath,
                title: newName,
                language: detectLanguage(newPath),
            });

            await addRecentFile(newPath);
            if (onRecentFilesChanged) await onRecentFilesChanged();
            await rebuildNativeMenu();
            errorService.showSuccess(`Renamed to ${newName}`);
        } catch (error) {
            errorService.showError('Failed to rename file', error as Error);
        }
    }, [tabs, updateTab, markExternallyModified, onRecentFilesChanged]);

    return {
        openFile,
        openFileFromDialog,
        saveFile,
        saveFileAs,
        reloadFileFromDisk,
        renameFile,
    };
}
