import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTabManager } from './useTabManager';
import { useFileManager } from './useFileManager';
import { useSettingsManager } from './useSettingsManager';
import { useSplitViewManager } from './useSplitViewManager';
import { saveSession, getLastSession, rebuildNativeMenu } from '../utils/fileOperations';
import { fileWatcher } from '../utils/fileWatcher';
import { detectEOL } from '../utils/fileOperations';
import { detectLanguageFromContent } from '../utils/contentLanguageDetection';
import { AUTO_LANGUAGE_DETECTION_THRESHOLD } from '../constants';
import { endTimer } from '../utils/perfMetrics';
import { disposeModelForTab } from '../utils/editorModels';

const SESSION_SAVE_INTERVAL_MS = 30_000; // periodic snapshot every 30 seconds

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
    const initializeEditorRef = useRef<() => Promise<void>>(async () => {});
    const [isInitializing, setIsInitializing] = useState(true);

    const fileManager = useFileManager(
        tabManager.tabs,
        tabManager.addTab,
        tabManager.updateTab,
        tabManager.markTabSaved,
        tabManager.getTabSaveSnapshot,
        tabManager.findTabByPath,
        tabManager.setActiveTabId,
        tabManager.markExternallyModified,
        onRecentFilesChanged
    );

    // Load settings and restore session on mount
    useEffect(() => {
        if (initializationStarted.current) return;
        initializationStarted.current = true;
        void initializeEditorRef.current()
            .catch(error => console.error('Editor initialization failed:', error))
            .finally(() => {
                setIsInitializing(false);
                endTimer('app-startup');
            });
    }, []);

    const initializeEditor = async () => {
        await settingsManager.loadSettings();

        // Wait briefly for macOS Apple Events ("Open With") to arrive before
        // checking startup args.  RunEvent::Opened fires asynchronously after
        // the webview loads; without this delay we'd see zero files and create
        // an unwanted untitled tab.
        await new Promise(resolve => setTimeout(resolve, 300));

        // Check for startup arguments (files opened via OS / command line)
        let startupFiles: string[] = [];
        let startupFolder: string | null = null;
        try {
            startupFiles = await invoke<string[]>('get_startup_args');
            startupFolder = await invoke<string | null>('get_startup_folder');
        } catch (err) {
            console.error('Failed to get startup args:', err);
        }

        // If launched with specific files (e.g. "Open With" / CLI args), skip
        // session restore — the user wants to see those files, not the old session.
        const hasExplicitFiles = startupFiles.length > 0 || startupFolder !== null;
        const session = hasExplicitFiles ? [] : await getLastSession();

        if (session.length > 0 || startupFiles.length > 0) {
            // Maps path → returned tab ID so we can activate the right tab afterwards
            const pathToTabId = new Map<string, string>();

            // Priority 1: Restore session (parallel with concurrency limit)
            if (session.length > 0) {
                // Restore untitled files synchronously (no disk I/O). Skip empty
                // ones — a blank untitled tab has nothing to recover, and older
                // sessions may still carry blanks saved before they were filtered.
                const untitled = session.filter(
                    f => f.is_untitled && f.content !== undefined && f.content.trim().length > 0
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

                // Restore disk files in parallel batches of 5
                const diskFiles = session.filter(f => !f.is_untitled);
                const BATCH_SIZE = 5;
                for (let i = 0; i < diskFiles.length; i += BATCH_SIZE) {
                    const batch = diskFiles.slice(i, i + BATCH_SIZE);
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
                        if (result.status === 'fulfilled' && result.value) {
                            const tabId = result.value;
                            const file = batch[idx];
                            pathToTabId.set(file.path, tabId);
                            // Re-apply unsaved edits captured in a crash snapshot
                            // on top of the freshly-opened (on-disk) content.
                            if (file.is_dirty && file.content !== undefined) {
                                tabManager.updateTab(tabId, {
                                    content: file.content,
                                    isDirty: true,
                                });
                            }
                        }
                    });
                }
            }

            // Priority 2: Open startup files (parallel)
            if (startupFiles.length > 0) {
                const results = await Promise.allSettled(
                    startupFiles.map(path => fileManager.openFile(path, 1, 1, 0, 0, true))
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
            if (desiredTabId) {
                tabManager.setActiveTabId(desiredTabId);
            }

            // If the session/startup restore produced no tabs at all (e.g. it held
            // only empty untitled tabs, which are now filtered out), fall back to a
            // single fresh untitled tab so the window is never left blank.
            if (pathToTabId.size === 0) {
                tabManager.createNewTab();
            }
        } else {
            // Only create a new untitled tab if no session exists AND no startup scripts
            if (tabManager.tabs.length === 0) {
                tabManager.createNewTab();
            }
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

        // Auto-detect language for untitled files when content changes significantly
        let newLanguage = tab.language;
        if (tab.path === null && tab.language === 'plaintext' && content.trim().length > AUTO_LANGUAGE_DETECTION_THRESHOLD) {
            const detectedLanguage = detectLanguageFromContent(content);
            if (detectedLanguage) {
                newLanguage = detectedLanguage;
            }
        }

        tabManager.updateTab(tabId, {
            content,
            isDirty: true,
            eol: detectEOL(content),
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

    // Periodic crash-recovery snapshot. Clearing the session on a clean quit is
    // handled synchronously in the backend `confirm_app_close` (so it can't race
    // teardown); a crash/kill skips that and restores from the last snapshot.
    useEffect(() => {
        const periodicSave = () => {
            if (closingRef.current) return;
            saveSession(sessionStateRef.current.tabs, sessionStateRef.current.activeTabId);
        };
        const interval = setInterval(periodicSave, SESSION_SAVE_INTERVAL_MS);
        return () => clearInterval(interval);
    }, []);

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
    const closeTab = useCallback(async (tabId: string) => {
        const tab = managedTabs.find(t => t.id === tabId);
        if (tab?.path) {
            fileWatcher.unwatch(tab.path);
        }
        // Remove the tab immediately after the caller's dirty check. Waiting on
        // IPC while it remains editable creates a second data-loss window.
        managedCloseTab(tabId);
        if (rightPaneTabId === tabId) {
            closeRightPane();
        }
        disposeModelForTab(tabId);

        if (tab?.path) {
            // --wait signalling is bookkeeping and must not delay UI closure.
            void invoke('signal_tab_closed', { path: tab.path })
                .catch(() => { /* non-critical */ });
        }
    }, [managedTabs, managedCloseTab, rightPaneTabId, closeRightPane]);

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
