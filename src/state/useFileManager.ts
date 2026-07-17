import { useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import type { DiskVersion, Tab } from '../types';
import { errorService } from '../services/ErrorService';
import {
    readFileContent,
    writeFileContent,
    openFileDialog,
    saveFileDialog,
    addRecentFile,
    rebuildNativeMenu,
    detectEOL,
    type FileWriteResult,
} from '../utils/fileOperations';
import { detectLanguage } from '../utils/languageDetection';
import { fileWatcher } from '../utils/fileWatcher';
import { LARGE_FILE_WARNING_BYTES, BYTES_PER_MB, MAX_FILE_SIZE_BYTES } from '../constants';
import { startTimer, endTimer } from '../utils/perfMetrics';
import { KeyedTaskQueue } from '../utils/keyedTaskQueue';
import type { TabSaveSnapshot } from './useTabManager';

/** Rejects saving a file whose chosen name is still the default "Untitled"
 *  form (e.g. "Untitled", "Untitled-3.txt"). Shared by Save and Save As. */
function isUntitledFileName(savePath: string): boolean {
    const fileName = savePath.split(/[/\\]/).pop() || '';
    const fileNameWithoutExt = fileName.replace(/\.[^.]+$/, '');
    return /^untitled(-\d+)?$/i.test(fileNameWithoutExt);
}

async function writeWithConflictConfirmation(
    path: string,
    content: string,
    encoding: string,
    expectedVersion: DiskVersion | null,
): Promise<FileWriteResult | null> {
    try {
        return await writeFileContent(path, content, encoding, expectedVersion);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ZITEXT_ENCODING_UNREPRESENTABLE:')) {
            const saveAsUtf8 = await ask(
                'This document contains characters that Windows-1252 cannot represent. Save it as UTF-8 instead?',
                {
                    title: 'Change Encoding?',
                    kind: 'warning',
                    okLabel: 'Save as UTF-8',
                    cancelLabel: 'Cancel',
                },
            );
            if (!saveAsUtf8) return null;
            return writeWithConflictConfirmation(path, content, 'UTF-8', expectedVersion);
        }
        if (!message.includes('ZITEXT_FILE_CONFLICT:')) throw error;
        const overwrite = await ask(
            `"${path.split(/[/\\]/).pop() || path}" changed on disk or was removed after it was opened.\n\n` +
            'Overwrite the external version with your current editor content?',
            {
                title: 'File Changed on Disk',
                kind: 'warning',
                okLabel: 'Overwrite',
                cancelLabel: 'Cancel',
            },
        );
        if (!overwrite) return null;
        return writeWithConflictConfirmation(path, content, encoding, null);
    }
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
    markTabSaved: (tabId: string, savedRevision: number, updates: Partial<Tab>) => boolean,
    getTabSaveSnapshot: (tabId: string) => TabSaveSnapshot,
    findTabByPath: (path: string) => Tab | undefined,
    setActiveTabId: (id: string) => void,
    markExternallyModified: (tabId: string) => void,
    onRecentFilesChanged?: () => Promise<void> | void
) {
    const openingFiles = useRef<Set<string>>(new Set());
    const saveQueue = useRef(new KeyedTaskQueue());
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    // Per-tab "revert baseline": the content the user last intentionally
    // committed — i.e. the content at open time and after each MANUAL save.
    // Autosave deliberately does NOT update this, so "Revert File" can discard
    // recent edits back to the last real save point even when autosave has
    // already written those edits to disk. (Without this, revert re-read a disk
    // that autosave kept current, so it appeared to do nothing.)
    const revertBaselineRef = useRef(new Map<string, string>());

    // Cleanup openingFiles when tabs change to ensure the lock is released
    // only after the tab actually appears in the state.
    useEffect(() => {
        const tabPaths = new Set(tabs.map(t => t.path).filter((p): p is string => p !== null));
        for (const path of openingFiles.current) {
            if (tabPaths.has(path)) {
                openingFiles.current.delete(path);
            }
        }
        // Drop revert baselines for tabs that no longer exist.
        const tabIds = new Set(tabs.map(t => t.id));
        for (const id of revertBaselineRef.current.keys()) {
            if (!tabIds.has(id)) revertBaselineRef.current.delete(id);
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

            // Warn for large files (between the 1 MB warning threshold and the
            // 10 MB hard limit; files above the limit are rejected by the backend
            // before we ever get here).
            if (result.size > LARGE_FILE_WARNING_BYTES) {
                const sizeMB = (result.size / BYTES_PER_MB).toFixed(1);
                const warnMB = (LARGE_FILE_WARNING_BYTES / BYTES_PER_MB).toFixed(0);
                const maxMB = (MAX_FILE_SIZE_BYTES / BYTES_PER_MB).toFixed(0);
                const fileName = path.split(/[/\\]/).pop();
                // Native Tauri dialog rather than window.confirm(), which does not
                // render reliably in a Tauri production webview.
                const proceed = await ask(
                    `File: ${fileName}\n` +
                    `Size: ${sizeMB} MB (larger than the ${warnMB} MB recommended limit)\n\n` +
                    `Files over ${warnMB} MB may open slowly and affect editor performance. ` +
                    `The maximum file size ZITEXT can open is ${maxMB} MB.\n\n` +
                    `Do you want to open it anyway?`,
                    { title: 'Large File Warning', kind: 'warning', okLabel: 'Open', cancelLabel: 'Cancel' }
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
                revision: 0,
                cursorLine,
                cursorColumn,
                isDirty: false,
                language,
                isReadOnly: false,
                encoding: result.encoding,
                diskVersion: {
                    modified: result.modified,
                    size: result.size,
                    hash: result.hash,
                },
                eol,
                scrollTop,
                scrollLeft,
                isUntitled: false,
                externallyModified: false,
                externalChangeCount: 0,
            };

            endTimer('file-open');
            // The just-read disk content is the initial revert baseline.
            revertBaselineRef.current.set(newTab.id, result.content);
            addTab(newTab);
            added = true;

            // Start watching file for external changes (cheap, no UI cost).
            fileWatcher.watch(path, () => {
                markExternallyModified(newTab.id);
            });

            // Defer recent-files persistence and the native-menu rebuild until
            // after the document paints. Rebuilding the macOS native menu runs on
            // the main thread (shared with the WebView), so doing it inline holds
            // the just-opened file off screen for a noticeable beat — especially
            // for files opened from the Explorer (which don't skip the rebuild).
            // A macrotask lets the editor render first, then the menu updates.
            setTimeout(async () => {
                try {
                    await addRecentFile(path);
                    if (onRecentFilesChanged) {
                        await onRecentFilesChanged();
                    }
                    if (!skipMenuRebuild) {
                        await rebuildNativeMenu();
                    }
                } catch (err) {
                    console.error('[openFile] deferred recent-files/menu update failed:', err);
                }
            }, 0);

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
    }, [addTab, findTabByPath, setActiveTabId, updateTab, onRecentFilesChanged, markExternallyModified]);

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
    // `isManualSave` distinguishes an explicit user save (Ctrl+S, File > Save,
    // save-on-close) from an autosave. Only manual saves advance the revert
    // baseline; autosave passes the default (false) so Revert can still discard
    // back past autosaved edits.
    const saveFile = useCallback((tabId: string, contentOverride?: string, isManualSave = false): Promise<boolean> => {
        // A formatter-supplied override is an explicit snapshot, so capture the
        // matching revision now. Ordinary saves intentionally capture both the
        // content and revision only when their queued operation begins.
        const overrideRevision = contentOverride === undefined
            ? undefined
            : getTabSaveSnapshot(tabId).revision;

        return saveQueue.current.enqueue(tabId, async (): Promise<boolean> => {
            const tab = tabsRef.current.find(t => t.id === tabId);
            if (!tab) return false;

            try {
                const initialSnapshot = getTabSaveSnapshot(tabId);
                let savePath = initialSnapshot.path;

            if (!savePath) {
                // Save As for untitled files
                let defaultName = initialSnapshot.title;
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

            const snapshot = getTabSaveSnapshot(tabId);
            const wasUntitled = !snapshot.path;
            const savedContent = contentOverride ?? snapshot.content;
            const savedRevision = overrideRevision ?? snapshot.revision;
            startTimer('file-save');
            const writeResult = await writeWithConflictConfirmation(
                savePath,
                savedContent,
                snapshot.encoding,
                snapshot.path ? snapshot.diskVersion : null,
            );
            if (!writeResult) return false;
            endTimer('file-save');

            // Update tab with new path and title
            const newTitle = savePath.split(/[/\\]/).pop() || 'Untitled';
            const savedLatestRevision = markTabSaved(tabId, savedRevision, {
                path: savePath,
                title: newTitle,
                language: detectLanguage(savePath),
                isUntitled: false,
                encoding: writeResult.encoding,
                diskVersion: {
                    modified: writeResult.modified,
                    size: writeResult.size,
                    hash: writeResult.hash,
                },
            });

            // Update file watcher:
            // • Untitled files were never watched — start watching now.
            // • Already-watched files — update the stored mod time so the next poll
            //   doesn't fire a false "externally modified" alert.
            if (wasUntitled) {
                fileWatcher.watch(savePath, () => markExternallyModified(tabId));
            } else {
                fileWatcher.updateVersion(savePath, {
                    modified: writeResult.modified,
                    size: writeResult.size,
                    exists: true,
                    identity: writeResult.identity,
                });
            }

            // A manual save is a new "last committed" point for Revert.
            if (isManualSave) {
                revertBaselineRef.current.set(tabId, savedContent);
            }

            await addRecentFile(savePath);
            if (onRecentFilesChanged) await onRecentFilesChanged();
            await rebuildNativeMenu();
            // Only announce explicit saves. Autosave runs silently in the
            // background — its "File saved" toast otherwise popped up on every
            // focus change (e.g. when opening the File menu to click Revert).
            if (isManualSave) {
                errorService.showSuccess(`File saved: ${savePath.split(/[\\/]/).pop()}`);
            }
            return savedLatestRevision;
        } catch (error) {
            errorService.showError('Failed to save file', error as Error);
            return false;
        }
        });
    }, [getTabSaveSnapshot, markTabSaved, markExternallyModified, onRecentFilesChanged]);

    /**
     * Save file with new name
     */
    const saveFileAs = useCallback((tabId: string): Promise<void> => {
        return saveQueue.current.enqueue(tabId, async () => {
            const tab = tabsRef.current.find(t => t.id === tabId);
            if (!tab) return;

            try {
            const initialSnapshot = getTabSaveSnapshot(tabId);
            const defaultName = initialSnapshot.path
                ? initialSnapshot.path.split(/[\\/]/).pop()!
                : (initialSnapshot.title.includes('.')
                    ? initialSnapshot.title
                    : initialSnapshot.title + '.txt');
            const savePath = await saveFileDialog(defaultName);
            if (!savePath) return;

            if (isUntitledFileName(savePath)) {
                errorService.showError(
                    'Invalid filename',
                    new Error('Cannot save file with "Untitled" as the filename. Please choose a different name.')
                );
                return;
            }

            const snapshot = getTabSaveSnapshot(tabId);
            const writeResult = await writeWithConflictConfirmation(
                savePath,
                snapshot.content,
                snapshot.encoding,
                savePath === snapshot.path ? snapshot.diskVersion : null,
            );
            if (!writeResult) return;

            // Update tab with new path and title
            const newTitle = savePath.split(/[/\\]/).pop() || 'Untitled';
            markTabSaved(tabId, snapshot.revision, {
                path: savePath,
                title: newTitle,
                language: detectLanguage(savePath),
                isUntitled: false,
                encoding: writeResult.encoding,
                diskVersion: {
                    modified: writeResult.modified,
                    size: writeResult.size,
                    hash: writeResult.hash,
                },
            });

            // Save As is always an explicit save — reset the revert baseline.
            revertBaselineRef.current.set(tabId, snapshot.content);

            // Unwatch the old path (if any) and start watching the new path.
            if (snapshot.path) {
                fileWatcher.unwatch(snapshot.path);
            }
            fileWatcher.watch(savePath, () => markExternallyModified(tabId));

            await addRecentFile(savePath);
            if (onRecentFilesChanged) await onRecentFilesChanged();
            await rebuildNativeMenu();
            errorService.showSuccess(`File saved as: ${savePath.split(/[\\/]/).pop()}`);
            } catch (error) {
                errorService.showError('Failed to save file', error as Error);
            }
        });
    }, [getTabSaveSnapshot, markTabSaved, markExternallyModified, onRecentFilesChanged]);

    /**
     * Reload file from disk (after external modification).
     * Returns whether the reload actually happened — false means the tab/path
     * was missing or the user backed out of the dirty-discard confirmation,
     * so callers can tell "cancelled" apart from "succeeded".
     */
    const reloadFileFromDisk = useCallback(async (
        tabId: string,
        skipDirtyConfirm = false,
    ): Promise<boolean> => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab || !tab.path) return false;

        try {
            if (tab.isDirty && !skipDirtyConfirm) {
                const confirmed = await ask(
                    `Reloading "${tab.title}" will discard your unsaved changes. Continue?`,
                    {
                        title: 'Discard Unsaved Changes?',
                        kind: 'warning',
                        okLabel: 'Reload',
                        cancelLabel: 'Cancel',
                    },
                );
                if (!confirmed) return false;
            }

            const result = await readFileContent(tab.path);
            const eol = detectEOL(result.content);

            updateTab(tabId, {
                content: result.content,
                eol,
                encoding: result.encoding,
                diskVersion: {
                    modified: result.modified,
                    size: result.size,
                    hash: result.hash,
                },
                isDirty: false,
                externallyModified: false,
            });

            // Update file watcher with new mod time
            fileWatcher.updateVersion(tab.path, {
                modified: result.modified,
                size: result.size,
                exists: true,
                identity: result.identity,
            });
            // Reloading from disk accepts the on-disk content as the new
            // baseline (this path is the external-change "Reload" action).
            revertBaselineRef.current.set(tabId, result.content);
            return true;
        } catch (error) {
            console.error('Failed to reload file:', error);
            throw error;
        }
    }, [tabs, updateTab]);

    /**
     * Revert File: discard edits made since the last intentional save, back to
     * the tab's revert baseline (content at open / last manual save). Unlike
     * reloadFileFromDisk this does NOT re-read the current disk — autosave may
     * have written the very edits we want to drop — and it writes the baseline
     * back to disk so those autosaved edits are actually undone in the file.
     * Returns true if it reverted, false if there was nothing to revert to.
     */
    const revertToBaseline = useCallback(async (tabId: string): Promise<boolean> => {
        const tab = tabsRef.current.find(t => t.id === tabId);
        if (!tab || !tab.path) return false;

        const baseline = revertBaselineRef.current.get(tabId);
        if (baseline === undefined) {
            // No baseline captured (shouldn't happen for a saved file) — fall
            // back to a plain disk reload so the menu action still does something.
            return reloadFileFromDisk(tabId, true);
        }

        try {
            // Overwrite whatever is on disk (expectedVersion=null) with the
            // baseline, so autosaved edits are removed from the file itself.
            const writeResult = await writeWithConflictConfirmation(
                tab.path,
                baseline,
                tab.encoding,
                null,
            );
            if (!writeResult) return false;

            updateTab(tabId, {
                content: baseline,
                eol: detectEOL(baseline),
                encoding: writeResult.encoding,
                diskVersion: {
                    modified: writeResult.modified,
                    size: writeResult.size,
                    hash: writeResult.hash,
                },
                isDirty: false,
                externallyModified: false,
            });

            fileWatcher.updateVersion(tab.path, {
                modified: writeResult.modified,
                size: writeResult.size,
                exists: true,
                identity: writeResult.identity,
            });
            return true;
        } catch (error) {
            console.error('Failed to revert file:', error);
            throw error;
        }
    }, [reloadFileFromDisk, updateTab]);

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
        revertToBaseline,
        renameFile,
    };
}
