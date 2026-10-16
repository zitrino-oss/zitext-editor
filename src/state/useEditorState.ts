import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SessionFile } from '../types';
import { errorService } from '../services/ErrorService';
import { detectLanguage } from '../utils/languageDetection';
import { useTabManager } from './useTabManager';
import { useFileManager } from './useFileManager';
import { useSettingsManager } from './useSettingsManager';
import { useSplitViewManager } from './useSplitViewManager';
import { saveSession, getLastSession, rebuildNativeMenu } from '../utils/fileOperations';
import { openListenersReady } from '../utils/openRequests';
import { fileWatcher } from '../utils/fileWatcher';
import { detectLanguageFromContent } from '../utils/contentLanguageDetection';
import { AUTO_LANGUAGE_DETECTION_THRESHOLD } from '../constants';
import { endTimer } from '../utils/perfMetrics';
import { disposeModelForTab } from '../utils/editorModels';
import { recoveryBaseline } from '../utils/recoveryBaseline';

const SESSION_SAVE_INTERVAL_MS = 30_000; // periodic snapshot every 30 seconds
// After an edit, snapshot once typing pauses (or at least every 10 s while it
// continues). A quit the app can't intercept (Dock Quit, logout, shutdown)
// then loses a couple of seconds of edits instead of up to 30.
const CHANGE_SNAPSHOT_DELAY_MS = 2_000;
const CHANGE_SNAPSHOT_MAX_WAIT_MS = 10_000;

// Content detection runs when this much text arrives at once (a paste), or
// when the document grows past one of these sizes while typing.
const DETECTION_PASTE_CHARS = 32;
const DETECTION_SIZE_STEPS = [AUTO_LANGUAGE_DETECTION_THRESHOLD, 80, 300, 1000, 4000];
function isDetectionPoint(previousLength: number, length: number): boolean {
    if (length - previousLength >= DETECTION_PASTE_CHARS) return true;
    return DETECTION_SIZE_STEPS.some(step => previousLength <= step && length > step);
}

/**
 * useEditorState - Main state orchestrator for the editor
 * 
 * Composes focused hooks (useTabManager, useFileManager, useSettingsManager)
 * to provide a clean, modular state management architecture.
 */
export function useEditorState(onRecentFilesChanged?: () => Promise<void> | void) {
    // Compose focused hooks
    const tabManager = useTabManager();
    const settingsManager = useSettingsManager();
    const splitViewManager = useSplitViewManager();
    const rightPaneTabId = splitViewManager.rightPaneTabId;
    const closeRightPane = splitViewManager.closeRightPane;
    const initializationStarted = useRef(false);
    // Crash snapshots start only once startup (including session restore)
    // has finished; an earlier snapshot would replace the stored session with
    // a partial set of tabs.
    const initializedRef = useRef(false);
    const lateRestoreUnlistenRef = useRef<UnlistenFn | null>(null);
    const restoreLateSessionRef = useRef<() => Promise<void>>(async () => {});
    const initializeEditorRef = useRef<() => Promise<void>>(async () => {});
    const [isInitializing, setIsInitializing] = useState(true);
    // A folder handed over at launch; App applies it to the project state.
    const [startupFolder, setStartupFolder] = useState<string | null>(null);
    const revealCounter = useRef(0);

    const fileManager = useFileManager(
        tabManager.tabs,
        tabManager.addTab,
        tabManager.updateTab,
        tabManager.markTabSaved,
        tabManager.getTabSaveSnapshot,
        tabManager.findTabIdByPath,
        tabManager.setActiveTabId,
        tabManager.markExternallyModified,
        onRecentFilesChanged
    );

    /** Moves a tab's cursor and asks its editor to scroll it into view. */
    const updateTabState = tabManager.updateTab;
    const requestReveal = useCallback((tabId: string, line: number, column: number) => {
        revealCounter.current += 1;
        updateTabState(tabId, { cursorLine: line, cursorColumn: column, revealRequest: revealCounter.current });
    }, [updateTabState]);

    /**
     * Opens a file requested from outside the app (command line, Finder,
     * second launch, drag and drop). If it can't be opened, a `zitext --wait`
     * for it is released at once instead of waiting until ZITEXT quits.
     */
    const openFile = fileManager.openFile;
    const findTabIdByPath = tabManager.findTabIdByPath;
    const openRequestedFile = useCallback(async (path: string, skipMenuRebuild = false): Promise<string | null> => {
        const tabId = await openFile(path, 1, 1, 0, 0, skipMenuRebuild);
        if (!tabId && !findTabIdByPath(path)) {
            void invoke('signal_tab_closed', { path }).catch(() => { /* bookkeeping only */ });
        }
        return tabId;
    }, [openFile, findTabIdByPath]);

    // Load settings and restore session on mount
    useEffect(() => {
        if (initializationStarted.current) return;
        initializationStarted.current = true;
        void initializeEditorRef.current()
            .catch(error => console.error('Editor initialization failed:', error))
            .finally(() => {
                initializedRef.current = true;
                setIsInitializing(false);
                endTimer('app-startup');
            });
    }, []);

    /**
     * Opens recovered disk-backed session entries. An entry whose file can no
     * longer be opened (deleted, moved, unreadable, too large) but that holds
     * unsaved content becomes a "Recovered" untitled tab, so that content is
     * never silently dropped and the next snapshot keeps it.
     */
    const restoreDiskEntries = async (entries: SessionFile[], pathToTabId: Map<string, string>) => {
        const BATCH_SIZE = 5;
        const recovered: string[] = [];
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(file => fileManager.openFile(
                    file.path,
                    file.cursor_line,
                    file.cursor_column,
                    file.scroll_top || 0,
                    file.scroll_left || 0,
                    true
                ))
            );
            results.forEach((result, idx) => {
                const file = batch[idx];
                const tabId = result.status === 'fulfilled' ? result.value : null;
                if (tabId) {
                    pathToTabId.set(file.path, tabId);
                    // Re-apply unsaved edits captured in a crash snapshot
                    // on top of the freshly-opened (on-disk) content.
                    if (file.is_dirty && file.content !== undefined) {
                        // Keep the version the edits were based on when the
                        // file changed after the crash, so saving asks
                        // instead of overwriting that change.
                        const opened = tabManager.getTabSaveSnapshot(tabId);
                        const { diskVersion, conflict } = recoveryBaseline(
                            file.base_version,
                            opened?.diskVersion ?? null,
                        );
                        tabManager.updateTab(tabId, {
                            content: file.content,
                            isDirty: true,
                            diskVersion,
                        });
                        if (conflict) tabManager.markExternallyModified(tabId);
                    }
                    return;
                }
                if (file.is_dirty && file.content !== undefined) {
                    const name = file.path.split(/[/\\]/).pop() || file.path;
                    const recoveredId = tabManager.createNewTab();
                    tabManager.updateTab(recoveredId, {
                        title: `Recovered - ${name}`,
                        content: file.content,
                        language: detectLanguage(file.path),
                        cursorLine: file.cursor_line,
                        cursorColumn: file.cursor_column,
                        isDirty: true,
                    });
                    pathToTabId.set(file.path, recoveredId);
                    recovered.push(name);
                }
            });
        }
        if (recovered.length > 0) {
            errorService.showWarning(
                `Recovered unsaved changes for ${recovered.length} file(s) that could not be reopened ` +
                `(${recovered.join(', ')}). They are open as "Recovered" tabs; use Save As to keep them.`,
            );
        }
    };

    // Late "Restore": fetch the now-released file entries and open the ones
    // that are not already open. Reassigned every render so it sees current tabs.
    restoreLateSessionRef.current = async () => {
        const session = await getLastSession();
        const openPaths = new Set(tabManager.tabs.map(t => t.path).filter(Boolean));
        const pending = session.filter(f => !f.is_untitled && !openPaths.has(f.path));
        if (pending.length === 0) return;
        await restoreDiskEntries(pending, new Map());
        await rebuildNativeMenu();
    };

    useEffect(() => () => {
        lateRestoreUnlistenRef.current?.();
        lateRestoreUnlistenRef.current = null;
    }, []);

    const initializeEditor = async () => {
        await settingsManager.loadSettings();

        // Wait briefly for macOS Apple Events ("Open With") to arrive before
        // checking startup args.  RunEvent::Opened fires asynchronously after
        // the webview loads; without this delay we'd see zero files and create
        // an unwanted untitled tab.
        await new Promise(resolve => setTimeout(resolve, 300));

        // Check for startup arguments (files opened via OS / command line).
        // Collecting them switches the backend from queueing to sending
        // events, so App's open listeners must exist first.
        await openListenersReady();
        let startupFiles: string[] = [];
        try {
            startupFiles = await invoke<string[]>('get_startup_args');
            const folder = await invoke<string | null>('get_startup_folder');
            if (folder) setStartupFolder(folder);
        } catch (err) {
            console.error('Failed to get startup args:', err);
        }

        // A "Restore" answered after get_last_session stopped waiting arrives
        // as an event; register before asking for the session.
        try {
            lateRestoreUnlistenRef.current = await listen('session-restore-late', () => {
                void restoreLateSessionRef.current().catch(error =>
                    console.error('Late session restore failed:', error));
            });
        } catch (err) {
            console.error('Failed to listen for late session restore:', err);
        }

        // Always restore the previous session, even when launched with files
        // ("Open With", CLI, double-click). Skipping it here used to let the
        // next snapshot overwrite unsaved crash-recovery content. The launched
        // files are opened afterwards and become the active tab.
        const session = await getLastSession();

        if (session.length > 0 || startupFiles.length > 0) {
            // Maps path → returned tab ID so we can activate the right tab afterwards
            const pathToTabId = new Map<string, string>();

            // Priority 1: Restore session (parallel with concurrency limit)
            if (session.length > 0) {
                // Restore untitled files synchronously (no disk I/O). Skip empty
                // ones — a blank untitled tab has nothing to recover, and older
                // sessions may still carry blanks saved before they were filtered.
                const untitled = session.filter(
                    f => f.is_untitled && f.content !== undefined && f.content.length > 0
                );
                for (const file of untitled) {
                    const tabId = tabManager.createNewTab();
                    tabManager.updateTab(tabId, {
                        title: file.path,
                        content: file.content!,
                        cursorLine: file.cursor_line,
                        cursorColumn: file.cursor_column,
                        scrollTop: file.scroll_top || 0,
                        scrollLeft: file.scroll_left || 0,
                        isDirty: true,
                    });
                    pathToTabId.set(file.path, tabId);
                }

                await restoreDiskEntries(session.filter(f => !f.is_untitled), pathToTabId);
            }

            // Priority 2: Open startup files (parallel)
            if (startupFiles.length > 0) {
                const results = await Promise.allSettled(
                    startupFiles.map(path => openRequestedFile(path, true))
                );
                results.forEach((result, idx) => {
                    if (result.status === 'fulfilled' && result.value) {
                        pathToTabId.set(startupFiles[idx], result.value);
                    }
                });
            }

            // Rebuild menu once after all files are loaded
            await rebuildNativeMenu();

            // Activate the desired tab directly using the tab ID we already know —
            // no timing-dependent ref/useEffect needed.
            let desiredTabId: string | null = null;
            if (startupFiles.length > 0) {
                const lastPath = startupFiles[startupFiles.length - 1];
                desiredTabId = pathToTabId.get(lastPath) ?? null;
            } else {
                // The previously-active tab is marked in the session itself
                // (active_tab_path is no longer exposed via read_settings).
                const activeFile = session.find(f => f.is_active);
                if (activeFile) desiredTabId = pathToTabId.get(activeFile.path) ?? null;
            }
            // A file opened while startup was running (Finder, a second launch,
            // during the restore prompt) is what the user asked for last:
            // leave it active instead of switching to a restored tab.
            const restoredIds = new Set(pathToTabId.values());
            const openedDuringStartup = tabManager.getTabIds().some(id => !restoredIds.has(id));
            if (desiredTabId && !openedDuringStartup) {
                tabManager.setActiveTabId(desiredTabId);
            }
        }
        // Never leave the window blank, but don't add an Untitled tab next to
        // tabs that exist (read synchronously; this closure's render state is
        // from before startup).
        if (tabManager.getTabIds().length === 0) {
            tabManager.createNewTab();
        }
    };
    initializeEditorRef.current = initializeEditor;

    // Enhanced updateTabContent with auto-language detection
    const updateTabContent = (tabId: string, content: string) => {
        const tab = tabManager.tabs.find(t => t.id === tabId);
        if (!tab) return;
        // Both split panes can observe the same Monaco model. Ignore the second
        // pane's echo instead of creating a duplicate revision/dirty transition.
        if (tabManager.getTabContent(tabId) === content) return;

        // Auto-detect the language of an untitled Plain Text document, unless
        // the user chose it. Only on a paste or when the text grows past a
        // size step, not on every keystroke.
        let newLanguage = tab.language;
        const previousLength = tabManager.getTabContent(tabId)?.length ?? 0;
        if (tab.path === null && tab.language === 'plaintext' && !tab.languageLocked
            && content.trim().length > AUTO_LANGUAGE_DETECTION_THRESHOLD
            && isDetectionPoint(previousLength, content.length)) {
            const detectedLanguage = detectLanguageFromContent(content);
            if (detectedLanguage) {
                newLanguage = detectedLanguage;
            }
        }

        tabManager.updateTab(tabId, {
            content,
            isDirty: true,
            // The editor keeps one line-ending style per document, so after an
            // edit a quick check is enough (no full scan per keystroke).
            eol: content.includes('\r\n') ? 'CRLF' : 'LF',
            language: newLanguage,
        });
    };

    // Remove the unused session_active localStorage key.
    useEffect(() => {
        localStorage.removeItem('session_active');
    }, []);

    // Keep the latest tabs/active tab in a ref so the periodic-save interval can
    // read current state without being recreated on every edit. Otherwise the
    // 30s timer was torn down and restarted on each keystroke, so crash-recovery
    // snapshots never fired during continuous typing.
    const sessionStateRef = useRef({ tabs: tabManager.tabs, activeTabId: tabManager.activeTabId });
    sessionStateRef.current = { tabs: tabManager.tabs, activeTabId: tabManager.activeTabId };

    // Set true when a confirmed app-close begins, so the periodic snapshot can't
    // repopulate the session the backend just cleared (between the clear and the
    // webview finishing teardown).
    const closingRef = useRef(false);
    const beginClose = useCallback(() => { closingRef.current = true; }, []);
    /** The quit didn't happen after all: snapshots resume. */
    const cancelClose = useCallback(() => { closingRef.current = false; }, []);

    // Periodic crash-recovery snapshot. Clearing the session on a clean quit is
    // handled synchronously in the backend `confirm_app_close` (so it can't race
    // teardown); a crash/kill skips that and restores from the last snapshot.
    useEffect(() => {
        const periodicSave = () => {
            if (closingRef.current || !initializedRef.current) return;
            saveSession(sessionStateRef.current.tabs, sessionStateRef.current.activeTabId);
        };
        const interval = setInterval(periodicSave, SESSION_SAVE_INTERVAL_MS);
        return () => clearInterval(interval);
    }, []);

    // Edit-triggered snapshot (see CHANGE_SNAPSHOT_DELAY_MS). Only content and
    // dirty-state changes count; cursor moves wait for the periodic snapshot.
    const contentSignature = tabManager.tabs
        .map(tab => `${tab.id}:${tab.revision}:${tab.isDirty ? 1 : 0}`)
        .join('|');
    const snapshotSignatureRef = useRef('');
    const firstUnsavedChangeRef = useRef<number | null>(null);
    useEffect(() => {
        if (isInitializing || contentSignature === snapshotSignatureRef.current) return;
        const now = Date.now();
        firstUnsavedChangeRef.current ??= now;
        const delay = Math.max(0, Math.min(
            CHANGE_SNAPSHOT_DELAY_MS,
            firstUnsavedChangeRef.current + CHANGE_SNAPSHOT_MAX_WAIT_MS - now,
        ));
        const timer = setTimeout(() => {
            firstUnsavedChangeRef.current = null;
            if (closingRef.current || !initializedRef.current) return;
            snapshotSignatureRef.current = contentSignature;
            saveSession(sessionStateRef.current.tabs, sessionStateRef.current.activeTabId);
        }, delay);
        return () => clearTimeout(timer);
    }, [contentSignature, isInitializing]);

    // Cleanup file watchers on unmount
    useEffect(() => {
        return () => {
            fileWatcher.unwatchAll();
        };
    }, []);

    // Wrap closeTab to stop watching and signal --wait mode when a tab is closed.
    const managedTabs = tabManager.tabs;
    const managedCloseTab = tabManager.closeTab;
    const clearExternalModification = tabManager.clearExternalModification;
    const getSaveSnapshot = tabManager.getTabSaveSnapshot;
    const closeTab = useCallback(async (tabId: string) => {
        // The current path from the synchronous snapshot: render state can lag
        // behind a Save As or rename that just finished (e.g. Save and Close
        // of an untitled tab), which left the new path watched and its
        // --wait unreleased.
        const path = getSaveSnapshot(tabId)?.path ?? null;
        fileWatcher.unwatchOwner(tabId);
        // Remove the tab immediately after the caller's dirty check. Waiting on
        // IPC while it remains editable creates a second data-loss window.
        managedCloseTab(tabId);
        if (rightPaneTabId === tabId) {
            closeRightPane();
        }
        disposeModelForTab(tabId);

        if (path) {
            // --wait signalling is bookkeeping and must not delay UI closure.
            void invoke('signal_tab_closed', { path })
                .catch(() => { /* non-critical */ });
        }
    }, [getSaveSnapshot, managedCloseTab, rightPaneTabId, closeRightPane]);

    const ignoreExternalChange = useCallback((tabId: string) => {
        const tab = managedTabs.find(candidate => candidate.id === tabId);
        if (tab?.path) fileWatcher.acknowledge(tab.path);
        clearExternalModification(tabId);
    }, [managedTabs, clearExternalModification]);

    return {
        // Tab management
        tabs: tabManager.tabs,
        activeTab: tabManager.activeTab,
        activeTabId: tabManager.activeTabId,
        setActiveTabId: tabManager.setActiveTabId,
        createNewTab: tabManager.createNewTab,
        closeTab,
        beginClose,
        cancelClose,
        updateTabContent,
        updateCursorPosition: tabManager.updateCursorPosition,
        updateScrollPosition: tabManager.updateScrollPosition,
        toggleReadOnly: tabManager.toggleReadOnly,
        changeLanguage: tabManager.changeLanguage,
        togglePreview: tabManager.togglePreview,
        togglePinTab: tabManager.togglePinTab,
        reorderTabs: tabManager.reorderTabs,

        // File operations
        openFile: fileManager.openFile,
        openRequestedFile,
        getTabContent: tabManager.getTabContent,
        requestReveal,
        startupFolder,
        clearStartupFolder: useCallback(() => setStartupFolder(null), []),
        openFileFromDialog: fileManager.openFileFromDialog,
        saveFile: fileManager.saveFile,
        saveFileAs: fileManager.saveFileAs,
        reloadFileFromDisk: fileManager.reloadFileFromDisk,
        revertToBaseline: fileManager.revertToBaseline,
        renameFile: fileManager.renameFile,
        ignoreExternalChange,

        // Settings
        settings: settingsManager.settings,
        isLoading: settingsManager.isLoading || isInitializing,
        updateSettings: settingsManager.updateSettings,

        // Split view
        splitViewEnabled: splitViewManager.splitViewEnabled,
        rightPaneTabId: splitViewManager.rightPaneTabId,
        toggleSplitView: splitViewManager.toggleSplitView,
        openInRightPane: splitViewManager.openInRightPane,
        closeRightPane: splitViewManager.closeRightPane,
        swapPanes: splitViewManager.swapPanes,
        disableSplitView: splitViewManager.disableSplitView,
    };
}
