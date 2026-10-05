import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { ask } from '@tauri-apps/plugin-dialog';
import { MenuBar } from './components/MenuBar';
import { TabBar } from './components/TabBar';
import { EditorPanel } from './components/EditorPanel';
import { MarkdownPreview } from './components/MarkdownPreview';
import { SplitView } from './components/SplitView';
import { StatusBar } from './components/StatusBar';
import { Breadcrumb } from './components/Breadcrumb';
import { GoToLineModal } from './components/GoToLineModal';
import { SettingsModal } from './components/SettingsModal';
import { FileExplorer } from './components/FileExplorer';
import { FindInFiles } from './components/FindInFiles';
import { ExternalChangePrompt } from './components/ExternalChangePrompt';
import { CommandPalette } from './components/CommandPalette';
import { KeybindingEditor } from './components/KeybindingEditor';
import { ToastContainer } from './components/ToastContainer';
import { WelcomeScreen } from './components/WelcomeScreen';
import { UnsavedChangesModal } from './components/UnsavedChangesModal';
import { UpdateAvailableModal } from './components/UpdateAvailableModal';
import { useUpdateChecker } from './hooks/useUpdateChecker';
import { initCrashReporter } from './utils/crashReporter';
import { startTimer } from './utils/perfMetrics';
import { startSession, endSession } from './utils/sessionHealth';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { FindReplaceBar } from './components/FindReplaceBar';
import { DialogFocusManager } from './components/DialogFocusManager';
import { useEditorState } from './state/useEditorState';
import { useProjectState } from './state/useProjectState';
import { useAutosave } from './state/useAutosave';
import { handleKeyDown, isMac, parseBinding, type ShortcutHandler } from './utils/shortcuts';
import { useResolvedTheme, readToken } from './utils/theme';
import { getLastSession, getRecentFiles } from './utils/fileOperations';
import { formatJson, minifyJson, validateJson, sortJsonKeys } from './utils/jsonTools';
import { formatXml, formatYaml, validateXml } from './utils/xmlYamlTools';
import { errorService } from './services/ErrorService';
import { MIN_FONT_SIZE, FONT_SIZE_STEP, MAX_FONT_SIZE } from './constants';
import type { editor } from 'monaco-editor';
import {
    copySelection, cutSelection, formatDocument, pasteFromClipboard,
    redo, selectAll, toggleLineComment, undo,
} from './utils/editorCommands';
import monaco, { ZITEXT_THEME, defineEditorTheme } from './monaco-config';
import { getModelForTab, modelUriForTab } from './utils/editorModels';
import { fileWatcher } from './utils/fileWatcher';
import './styles.css';

/* Must stay on zitext.com: open_url_in_browser rejects any other host. */
const RELEASE_NOTES_URL = 'https://zitext.com/changelog';

interface HandlersRef {
    createNewTab: () => string;
    openFile: (path: string, line?: number, col?: number, scrollTop?: number, scrollLeft?: number, skipMenu?: boolean) => Promise<string | null>;
    openFileFromDialog: () => Promise<void>;
    handleOpenFolder: () => Promise<void>;
    activeTabId: string | null;
    saveFile: (id: string, contentOverride?: string) => Promise<boolean>;
    saveFileAs: (id: string) => Promise<void>;
    handleCloseTab: (id: string) => void;
    handleFind: () => void;
    handleReplace: () => void;
    handleRevertFile: () => Promise<void>;
    handleToggleTheme: () => void;
    handleToggleWordWrap: () => void;
    handleToggleReadOnly: () => void;
    handleFormatDocument: () => void;
    toggleSidebar: () => void;
    handleCopyPath: () => void;
    handleChangeLanguage: (lang: string) => void;
    handleToggleSplitView: () => void;
    handleOpenInRightPane: () => void;
    handleSwapPanes: () => void;
    handleOpenRecent: (path: string) => Promise<void>;
    togglePreview: (id: string) => void;
}

function App() {
    const {
        tabs,
        activeTab,
        activeTabId,
        settings,
        isLoading,
        createNewTab,
        openFile,
        openFileFromDialog,
        saveFile,
        saveFileAs,
        closeTab,
        beginClose,
        setActiveTabId,
        updateTabContent,
        updateCursorPosition,
        updateScrollPosition,
        toggleReadOnly,
        changeLanguage,
        reorderTabs,
        renameFile,
        reloadFileFromDisk,
        revertToBaseline,
        ignoreExternalChange,
        updateSettings,
        splitViewEnabled,
        rightPaneTabId,
        toggleSplitView,
        openInRightPane,
        swapPanes,
        togglePreview,
        togglePinTab,
    } = useEditorState(async () => {
        await loadRecentFiles();
    });

    const {
        openedFolder,
        sidebarCollapsed,
        sidebarWidth,
        openFolder,
        closeFolder,
        toggleSidebar,
        updateSidebarWidth,
        setOpenedFolder,
    } = useProjectState(
        settings.openedFolder,
        settings.sidebarCollapsed,
        settings.sidebarWidth,
    );

    // 'system' never reaches CSS or Monaco — it is resolved to a concrete
    // light/dark here, and re-resolved live while the OS setting changes.
    const resolvedTheme = useResolvedTheme(settings.theme);

    // One theme drives the whole app, and the editor uses a theme built from the
    // same tokens as the chrome, so the two surfaces are the same colour. A
    // stale editorTheme in settings.json (including the removed high-contrast
    // values) is simply ignored.
    const effectiveEditorTheme = ZITEXT_THEME;

    // Mirror theme to <html data-theme> so the pre-paint CSS in index.html
    // stays in sync after settings load. localStorage keeps the *preference*
    // rather than the resolved value, so a 'system' user still follows the OS
    // on next launch. Also ask the Rust side to set the native window theme on
    // Windows (titlebar follows).
    // Monaco is rebuilt here too rather than in an effect of its own. Its theme
    // is derived from the same tokens as the chrome, so it has to be rebuilt
    // *after* data-theme flips — and reading a computed custom property forces
    // the pending style recalculation, so the tokens below are already the new
    // theme's. Doing both in one layout effect also means the editor and the
    // chrome change in the same paint, with no flash of a half-switched window.
    //
    // This deliberately does not defer to requestAnimationFrame. The browser
    // stops serving frames whenever the page isn't being rendered — window
    // minimised, occluded by another window, or the tab in the background — so
    // a deferred callback simply never ran, and the next theme change cancelled
    // it. The chrome would switch and the editor would stay on the old theme.
    useLayoutEffect(() => {
        document.documentElement.setAttribute('data-theme', resolvedTheme);
        try { localStorage.setItem('zitext_theme', settings.theme); } catch { /* private browsing */ }
        // The native window theme is owned by useResolvedTheme — it has to be
        // the *preference*, not the resolved value, or 'system' pins itself.

        monaco.editor.setTheme(defineEditorTheme(resolvedTheme === 'dark', readToken));
    }, [settings.theme, resolvedTheme]);

    // Chrome typeface. Overrides --font-ui on <html> rather than replacing the
    // token, so the stylesheet keeps its fallback stack if the setting is blank.
    useEffect(() => {
        const root = document.documentElement;
        if (settings.uiFont) root.style.setProperty('--font-ui', settings.uiFont);
        else root.style.removeProperty('--font-ui');
    }, [settings.uiFont]);

    // Update checker (must be called before any conditional returns / derived values)
    const { update: availableUpdate, dismiss: dismissUpdate } = useUpdateChecker(settings.checkForUpdates);

    // UI state
    const [goToLineModalOpen, setGoToLineModalOpen] = useState(false);
    const [settingsModalOpen, setSettingsModalOpen] = useState(false);
    const [aboutModalOpen, setAboutModalOpen] = useState(false);
    const [appVersion, setAppVersion] = useState('');
    useEffect(() => { getVersion().then(setAppVersion); }, []);
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
    const [keybindingEditorOpen, setKeybindingEditorOpen] = useState(false);
    const [recentFiles, setRecentFiles] = useState<string[]>([]);
    const recentFilesRef = useRef<string[]>([]);
    const [dragCounter, setDragCounter] = useState(0);
    const [unsavedChangesModalOpen, setUnsavedChangesModalOpen] = useState(false);
    const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
    const [showFindInFiles, setShowFindInFiles] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [appCloseModalOpen, setAppCloseModalOpen] = useState(false);
    const closeRequestTokenRef = useRef<string | null>(null);

    // Editor instances + active pane tracking
    const [leftEditorInstance, setLeftEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
    const [rightEditorInstance, setRightEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
    const activePaneRef = useRef<'left' | 'right'>('left');
    const [activePane, setActivePane] = useState<'left' | 'right'>('left');
    const [selectionLength, setSelectionLength] = useState(0);

    // The tab that currently has focus (left pane unless split view + right pane is focused)
    const focusedTabId = splitViewEnabled && activePane === 'right' ? rightPaneTabId : activeTabId;
    const focusedTab = focusedTabId ? (tabs.find(t => t.id === focusedTabId) ?? null) : null;

    useEffect(() => {
        if (activePane === 'right' && (!splitViewEnabled || !rightPaneTabId)) {
            activePaneRef.current = 'left';
            setActivePane('left');
        }
    }, [activePane, splitViewEnabled, rightPaneTabId]);

    const handlersRef = useRef<HandlersRef | null>(null);

    // Mirror the live tab count so the once-registered beforeunload handler
    // reports the real number rather than the initial (empty) closure value.
    const tabsCountRef = useRef(tabs.length);
    tabsCountRef.current = tabs.length;

    // Mirror live tabs so the once-registered close-request listener can check
    // for unsaved changes without re-subscribing.
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    // Initialize crash reporter, session health, and startup timer once
    useEffect(() => {
        startTimer('app-startup');
        initCrashReporter();
        startSession();
        const handleEnd = () => endSession(tabsCountRef.current);
        window.addEventListener('beforeunload', handleEnd);
        return () => window.removeEventListener('beforeunload', handleEnd);
    }, []);

    // App-close guard: the backend intercepts window-close / app-exit and emits
    // 'close-requested'. Prompt if any tab has unsaved changes; otherwise let the
    // close proceed.
    useEffect(() => {
        let unlisten: (() => void) | null = null;
        let cancelled = false;
        listen<string>('close-requested', (event) => {
            closeRequestTokenRef.current = event.payload;
            if (tabsRef.current.some(t => t.isDirty)) {
                setAppCloseModalOpen(true);
            } else {
                beginClose();
                invoke('confirm_app_close', { token: event.payload })
                    .finally(() => { closeRequestTokenRef.current = null; })
                    .catch(() => { /* window already closing */ });
            }
        }).then((u) => { if (cancelled) u(); else unlisten = u; });
        return () => { cancelled = true; if (unlisten) unlisten(); };
    }, [beginClose]);

    // Listen for custom find/replace events dispatched by Monaco override
    useEffect(() => {
        const onFind = () => { setFindShowReplace(false); setFindOpen(true); };
        const onReplace = () => { setFindShowReplace(true); setFindOpen(true); };
        window.addEventListener('zitext-find', onFind);
        window.addEventListener('zitext-replace', onReplace);
        return () => {
            window.removeEventListener('zitext-find', onFind);
            window.removeEventListener('zitext-replace', onReplace);
        };
    }, []);

    // Autosave: save all dirty tabs with saved paths
    const { notifyChange: notifyAutosaveChange } = useAutosave({
        mode: settings.autosave,
        delay: settings.autosaveDelay,
        // Must match the save-loop predicate below exactly. Keying on `t.path`
        // (not `!t.isUntitled`) avoids a no-op autosave loop for the edge case
        // of a dirty tab that is not "untitled" yet still has no path.
        isDirty: tabs.some(t => t.isDirty && !!t.path),
        activeTabId,
        onSave: async () => {
            let allSaved = true;
            for (const tab of tabs) {
                if (tab.isDirty && tab.path) {
                    allSaved = await saveFile(tab.id) && allSaved;
                }
            }
            return allSaved;
        },
    });

    // Feed edits into the autosave debounce (After Delay mode). Wrapping
    // updateTabContent keeps every content-change path — typing, paste, and the
    // JSON/XML/YAML tools — resetting the same timer.
    const updateTabContentAndAutosave = useCallback((tabId: string, content: string) => {
        updateTabContent(tabId, content);
        notifyAutosaveChange();
    }, [updateTabContent, notifyAutosaveChange]);

    const loadRecentFiles = useCallback(async () => {
        const files = await getRecentFiles();
        setRecentFiles(files);
        recentFilesRef.current = files;
    }, []);

    useEffect(() => {
        void loadRecentFiles();
    }, [loadRecentFiles]);

    // Paths of open tabs with unsaved changes, so the explorer can mark them the
    // way the tab bar does. A Set keeps the per-row lookup O(1) — the tree
    // re-renders on every keystroke that flips a tab's dirty flag.
    const dirtyPaths = useMemo(
        () => new Set(tabs.filter(t => t.isDirty && t.path).map(t => t.path as string)),
        [tabs],
    );

    // Caption for the titlebar: "file — project", per the design.
    const windowTitle = useMemo(() => {
        const folder = openedFolder?.split(/[/\\]/).filter(Boolean).pop() ?? null;
        if (!activeTab) return folder ?? 'ZITEXT Editor';
        const fileName = activeTab.path ? activeTab.path.split(/[/\\]/).pop() : 'Untitled';
        return folder ? `${fileName} — ${folder}` : `${fileName}`;
    }, [activeTab, openedFolder]);

    // The OS window title is the same caption the custom titlebar draws, so the
    // three platforms read identically. Only Windows runs undecorated and paints
    // its own bar; macOS and Linux show this one, and previously it was a
    // different string ("file - ZITEXT Editor"), which no one noticed on Windows
    // because the native titlebar is hidden there.
    //
    // The dirty marker stays: a window list is where an unsaved file is easiest
    // to miss, and the tab bar carries its own dot regardless.
    useEffect(() => {
        const dirty = activeTab?.isDirty ? '● ' : '';
        getCurrentWindow()
            .setTitle(`${dirty}${windowTitle}`)
            .catch(() => { /* no window title on platforms without one */ });
    }, [windowTitle, activeTab?.isDirty]);

    // ─── Active pane helpers ────────────────────────────────────────────────

    const getActiveEditor = useCallback(() => {
        if (splitViewEnabled && activePane === 'right') {
            return rightEditorInstance;
        }
        return leftEditorInstance;
    }, [splitViewEnabled, activePane, leftEditorInstance, rightEditorInstance]);

    // The rendered Markdown body, so Find can search the preview in place rather
    // than forcing the tab back to source view.
    const previewBodyRef = useRef<HTMLDivElement>(null);
    const getPreviewElement = useCallback(() => previewBodyRef.current, []);

    // ─── Split view handlers ────────────────────────────────────────────────

    const handleToggleSplitView = useCallback(() => {
        if (!splitViewEnabled) {
            if (activeTabId) openInRightPane(activeTabId);
        } else {
            toggleSplitView();
        }
    }, [splitViewEnabled, activeTabId, openInRightPane, toggleSplitView]);

    const handleOpenInRightPane = useCallback(() => {
        if (activeTabId) openInRightPane(activeTabId);
    }, [activeTabId, openInRightPane]);

    const handleSwapPanes = useCallback(() => {
        const newId = swapPanes(activeTabId || undefined);
        if (newId) setActiveTabId(newId);
    }, [swapPanes, activeTabId, setActiveTabId]);

    // ─── Tab close with unsaved-changes guard ───────────────────────────────

    const handleCloseTab = useCallback((tabId: string) => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;
        if (tab.isPinned) {
            errorService.showError('Tab is pinned. Unpin it first to close.');
            return;
        }
        if (tab.isDirty) {
            setPendingCloseTabId(tabId);
            setUnsavedChangesModalOpen(true);
        } else {
            closeTab(tabId);
        }
    }, [tabs, closeTab]);

    const handleSaveAndClose = async () => {
        const id = pendingCloseTabId;
        if (!id) return;
        const saved = await handleSave(id);
        // Only close once the save actually succeeded. If the user cancelled the
        // Save-As dialog (or the write failed), keep the tab so content isn't lost.
        if (!saved) return;
        closeTab(id);
        setUnsavedChangesModalOpen(false);
        setPendingCloseTabId(null);
    };

    const handleDontSaveAndClose = () => {
        if (pendingCloseTabId) {
            closeTab(pendingCloseTabId);
            setUnsavedChangesModalOpen(false);
            setPendingCloseTabId(null);
        }
    };

    const handleCancelClose = () => {
        setUnsavedChangesModalOpen(false);
        setPendingCloseTabId(null);
    };

    // ─── Save with optional format-on-save ─────────────────────────────────

    const formatTabContent = useCallback(async (tabId: string): Promise<string | undefined> => {
        const tab = tabs.find(candidate => candidate.id === tabId);
        if (!tab) return undefined;

        const uri = modelUriForTab(tabId);
        let model = getModelForTab(tabId);
        if (!model) {
            model = monaco.editor.createModel(tab.content, tab.language, monaco.Uri.parse(uri));
        }

        const visibleEditor = [leftEditorInstance, rightEditorInstance].find(
            instance => instance?.getModel()?.uri.toString() === uri,
        ) ?? null;
        const temporaryEditor = visibleEditor
            ? null
            : monaco.editor.create(document.createElement('div'), {
                model,
                automaticLayout: false,
                readOnly: false,
            });
        const targetEditor = visibleEditor ?? temporaryEditor;

        try {
            await targetEditor?.getAction('editor.action.formatDocument')?.run();
            const formatted = model.getValue();
            // A detached editor has no React onChange bridge, so synchronize
            // its formatted value explicitly. Visible editors do this through
            // their normal Monaco content listener.
            if (temporaryEditor && formatted !== tab.content) {
                updateTabContentAndAutosave(tabId, formatted);
            }
            return formatted;
        } catch {
            return model.getValue();
        } finally {
            temporaryEditor?.dispose();
        }
    }, [tabs, leftEditorInstance, rightEditorInstance, updateTabContentAndAutosave]);

    const handleSave = useCallback(async (tabId: string): Promise<boolean> => {
        let contentOverride: string | undefined;
        if (settings.formatOnSave) {
            contentOverride = await formatTabContent(tabId);
        }
        // Manual save (Ctrl+S / File > Save / save-on-close) — advances the
        // revert baseline, unlike autosave which calls saveFile directly.
        return await saveFile(tabId, contentOverride, true);
    }, [settings.formatOnSave, formatTabContent, saveFile]);

    // ─── App-close (quit) with unsaved-changes prompt ───────────────────────

    const handleSaveAllAndQuit = async () => {
        const dirty = tabs.filter(t => t.isDirty);
        for (const t of dirty) {
            const ok = await handleSave(t.id);
            if (!ok) {
                setAppCloseModalOpen(false);
                const token = closeRequestTokenRef.current;
                closeRequestTokenRef.current = null;
                if (token) {
                    await invoke('cancel_app_close', { token }).catch(() => { /* request already expired */ });
                }
                return;
            }
        }
        setAppCloseModalOpen(false);
        beginClose();
        const token = closeRequestTokenRef.current;
        closeRequestTokenRef.current = null;
        if (token) {
            await invoke('confirm_app_close', { token }).catch(() => { /* window already closing */ });
        }
    };

    const handleQuitWithoutSaving = async () => {
        setAppCloseModalOpen(false);
        beginClose();
        const token = closeRequestTokenRef.current;
        closeRequestTokenRef.current = null;
        if (token) {
            await invoke('confirm_app_close', { token }).catch(() => { /* window already closing */ });
        }
    };

    const handleCancelQuit = () => {
        setAppCloseModalOpen(false);
        const token = closeRequestTokenRef.current;
        closeRequestTokenRef.current = null;
        if (token) {
            invoke('cancel_app_close', { token }).catch(() => { /* request already expired */ });
        }
    };

    // ─── Revert file ────────────────────────────────────────────────────────

    const handleRevertFile = useCallback(async () => {
        if (!focusedTabId || !focusedTab?.path) return;
        const confirmed = await ask(
            `Revert "${focusedTab.title}" to last saved state? Unsaved changes will be lost.`,
            {
                title: 'Revert File?',
                kind: 'warning',
                okLabel: 'Revert',
                cancelLabel: 'Cancel',
            },
        );
        if (confirmed) {
            try {
                // Revert to the last intentional save point (the tab's baseline),
                // not the current disk contents — autosave may have already
                // written the edits we're discarding. revertToBaseline rewrites
                // the file with the baseline so those autosaved edits are undone.
                const reverted = await revertToBaseline(focusedTabId);
                if (reverted) {
                    errorService.showSuccess(`Reverted to saved version`);
                }
            } catch (error) {
                // Surface failures (locked file, permissions, etc.) instead of
                // silently swallowing them as an unhandled rejection.
                errorService.showError('Failed to revert file', error as Error);
            }
        }
    }, [focusedTabId, focusedTab, revertToBaseline]);

    // ─── Find / Replace (custom bar) ──────────────────────────────────────

    const [findOpen, setFindOpen] = useState(false);
    const [findShowReplace, setFindShowReplace] = useState(false);

    // Find works in both modes: against the Monaco model in editor mode, and
    // against the rendered DOM while a tab shows the Markdown preview (see
    // FindReplaceBar). Replace has no meaning on rendered output, so that one
    // — and only that one — drops back to the editor first.
    const handleFind = useCallback(() => {
        setFindShowReplace(false);
        setFindOpen(true);
    }, []);

    const handleReplace = useCallback(() => {
        if (focusedTab?.isPreview) togglePreview(focusedTab.id);
        setFindShowReplace(true);
        setFindOpen(true);
    }, [focusedTab, togglePreview]);

    // ─── Edit menu commands (Windows/Linux) ─────────────────────────────────
    // macOS gets these from the native menubar's PredefinedMenuItems; the in-app
    // <MenuBar> has no equivalent, so drive the focused editor directly. Clipboard
    // work goes through utils/editorCommands for the WebView2 reasons noted there.

    const runEditorCommand = useCallback((command: (ed: editor.ICodeEditor) => void | Promise<void>) => {
        const ed = getActiveEditor();
        // A disposed instance survives a preview toggle, so require a live model.
        if (!ed?.getModel()) return;
        void command(ed);
    }, [getActiveEditor]);

    const handleUndo = useCallback(() => runEditorCommand(undo), [runEditorCommand]);
    const handleRedo = useCallback(() => runEditorCommand(redo), [runEditorCommand]);
    const handleCut = useCallback(() => runEditorCommand(cutSelection), [runEditorCommand]);
    const handleCopy = useCallback(() => runEditorCommand(copySelection), [runEditorCommand]);
    const handlePaste = useCallback(() => runEditorCommand(pasteFromClipboard), [runEditorCommand]);
    const handleSelectAll = useCallback(() => runEditorCommand(selectAll), [runEditorCommand]);
    const handleToggleLineComment = useCallback(() => runEditorCommand(toggleLineComment), [runEditorCommand]);
    const handleFormatDocument = useCallback(() => runEditorCommand(formatDocument), [runEditorCommand]);

    // ─── Other editor actions ───────────────────────────────────────────────

    const handleGoToLine = (lineNumber: number) => {
        if (focusedTab) updateCursorPosition(focusedTab.id, lineNumber, 1);
    };

    const handleToggleTheme = () => {
        // Toggling off 'system' commits to whatever it was showing, inverted —
        // the menu item is a light/dark switch, not a tri-state cycle.
        const newTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
        updateSettings({ theme: newTheme, editorTheme: newTheme === 'dark' ? 'vs-dark' : 'vs' });
    };

    const handleToggleWordWrap = () => updateSettings({ wordWrap: !settings.wordWrap });

    // Full screen. macOS gets "Enter Full Screen" injected into the View menu by
    // AppKit itself; Windows/Linux get nothing, so drive it through the window
    // API and expose it on the in-app menubar under the usual F11.
    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
        // The window can start full screen (restored session, OS state), so seed
        // from the real value rather than assuming false.
        getCurrentWindow().isFullscreen()
            .then(setIsFullscreen)
            .catch(() => { /* non-fatal: label just starts at "Enter" */ });
    }, []);

    const handleToggleFullScreen = useCallback(async () => {
        const appWindow = getCurrentWindow();
        try {
            // Read the live value instead of trusting local state, which can drift
            // if the window was changed by any other means.
            const next = !(await appWindow.isFullscreen());
            await appWindow.setFullscreen(next);
            setIsFullscreen(next);
        } catch (error) {
            errorService.showError('Failed to toggle full screen', error as Error);
        }
    }, []);

    const handleToggleReadOnly = () => {
        if (focusedTabId) toggleReadOnly(focusedTabId);
    };

    /* Opens the changelog in the user's default browser. The backend only
       accepts https://zitext.com URLs, so the host here is not incidental —
       anything else is rejected rather than opened. */
    const handleOpenReleaseNotes = useCallback(() => {
        invoke('open_url_in_browser', { url: RELEASE_NOTES_URL }).catch((error) => {
            errorService.showError('Failed to open the release notes', error as Error);
        });
    }, []);

    const handleOpenRecent = useCallback(async (path: string) => {
        try {
            // Grant access before opening. The in-app Recent Files list and the
            // Welcome screen don't go through the macOS native menu (which grants
            // on its own), so the backend would otherwise deny the read. The
            // command only grants paths already in the persisted recent list.
            await invoke('grant_recent_path', { path }).catch(() => { /* may already be granted */ });
            // Try to restore cursor/scroll position from the last saved session.
            const session = await getLastSession();
            const entry = session.find(s => s.path === path);
            await openFile(
                path,
                entry?.cursor_line ?? 1,
                entry?.cursor_column ?? 1,
                entry?.scroll_top ?? 0,
                entry?.scroll_left ?? 0,
                true
            );
        } catch (error) {
            errorService.showError('Failed to open file', error as Error);
        }
    }, [openFile]);

    const handleChangeLanguage = (language: string) => {
        if (focusedTabId) changeLanguage(focusedTabId, language);
    };

    const handleOpenFolder = async () => {
        const path = await openFolder();
        if (path) await updateSettings({ openedFolder: path, sidebarCollapsed: false });
    };

    const handleFileSelect = async (path: string) => {
        try {
            await openFile(path);
        } catch (error) {
            errorService.showError('Failed to open file', error as Error);
        }
    };

    const handleCloseFolder = async () => {
        closeFolder();
        await updateSettings({ openedFolder: null, sidebarCollapsed: true });
    };

    const sidebarPersistTimerRef = useRef<number | null>(null);
    const handleSidebarWidthChange = useCallback((width: number) => {
        updateSidebarWidth(width);
        if (sidebarPersistTimerRef.current !== null) {
            window.clearTimeout(sidebarPersistTimerRef.current);
        }
        sidebarPersistTimerRef.current = window.setTimeout(() => {
            sidebarPersistTimerRef.current = null;
            void updateSettings({ sidebarWidth: width });
        }, 250);
    }, [updateSidebarWidth, updateSettings]);

    useEffect(() => () => {
        if (sidebarPersistTimerRef.current !== null) {
            window.clearTimeout(sidebarPersistTimerRef.current);
        }
    }, []);

    const handleToggleSidebar = useCallback(() => {
        toggleSidebar();
        void updateSettings({ sidebarCollapsed: !sidebarCollapsed });
    }, [toggleSidebar, updateSettings, sidebarCollapsed]);

    const handleCopyPath = async () => {
        if (focusedTab?.path) {
            try {
                await navigator.clipboard.writeText(focusedTab.path);
                errorService.showSuccess('File path copied to clipboard');
            } catch (error) {
                errorService.showError('Failed to copy file path', error as Error);
            }
        }
    };

    const handleOpenFileAtLine = async (path: string, line: number) => {
        try {
            await openFile(path, line, 1, 0, 0);
            setShowFindInFiles(false);
        } catch (error) {
            errorService.showError('Failed to open file', error as Error);
        }
    };

    // ─── Keep handlers ref current (for stable event listeners) ────────────

    handlersRef.current = {
        createNewTab,
        openFile,
        openFileFromDialog,
        handleOpenFolder,
        activeTabId: focusedTabId,
        saveFile: handleSave,
        saveFileAs,
        handleCloseTab,
        handleFind,
        handleReplace,
        handleRevertFile,
        handleToggleTheme,
        handleToggleWordWrap,
        handleToggleReadOnly,
        handleFormatDocument,
        toggleSidebar: handleToggleSidebar,
        handleCopyPath,
        handleChangeLanguage,
        handleToggleSplitView,
        handleOpenInRightPane,
        handleSwapPanes,
        handleOpenRecent,
        togglePreview,
    };

    // ─── Keyboard shortcuts ─────────────────────────────────────────────────

    // The shortcut table is rebuilt every render (cheap) with fresh handler
    // closures and stashed in a ref. The capture-phase listener below is then
    // registered ONCE, so typing (which changes `tabs` on every keystroke) no
    // longer tears down and re-adds the global keydown listener each time.
    const shortcutsRef = useRef<ShortcutHandler[]>([]);
    {
        // Return custom parsed binding when the user has remapped a command,
        // otherwise fall back to the provided defaults.
        const kb = (
            id: string,
            defaults: { key: string; ctrlOrCmd: boolean; shift?: boolean; alt?: boolean },
        ) => {
            const custom = settings.keybindings[id];
            return custom ? parseBinding(custom) : defaults;
        };

        shortcutsRef.current = [
            { ...kb('new',           { key: 'n', ctrlOrCmd: true }),              action: createNewTab },
            { ...kb('open',          { key: 'o', ctrlOrCmd: true }),              action: openFileFromDialog },
            // stopPropagation: Monaco reads Ctrl+K as the start of a chord.
            { ...kb('openFolder',    { key: 'k', ctrlOrCmd: true }),              action: handleOpenFolder, stopPropagation: true },
            { ...kb('save',          { key: 's', ctrlOrCmd: true, shift: false }),  action: () => focusedTabId && handleSave(focusedTabId) },
            { ...kb('saveAs',        { key: 's', ctrlOrCmd: true, shift: true }), action: () => focusedTabId && saveFileAs(focusedTabId) },
            { ...kb('close',         { key: 'w', ctrlOrCmd: true }),              action: () => focusedTabId && handleCloseTab(focusedTabId) },
            { ...kb('find',          { key: 'f', ctrlOrCmd: true, shift: false }),  action: handleFind },
            { key: 'f', ctrlOrCmd: true, shift: true, action: () => setShowFindInFiles(v => !v) },
            { ...kb('replace',       { key: 'h', ctrlOrCmd: true }),              action: handleReplace },
            { ...kb('goToLine',      { key: 'g', ctrlOrCmd: true }),              action: () => setGoToLineModalOpen(true) },
            { ...kb('commandPalette',{ key: 'p', ctrlOrCmd: true, shift: true }), action: () => setCommandPaletteOpen(true) },
            // Plain Ctrl/Cmd+P also opens the palette. This intercepts the key before the
            // Windows WebView2 default, which would otherwise open the OS print dialog
            // (the app has no print feature). See QA ZITEXT_V2_003.
            { key: 'p', ctrlOrCmd: true, shift: false, action: () => setCommandPaletteOpen(true) },
            { key: '\\', ctrlOrCmd: true, action: handleToggleSplitView },
            { key: '=', ctrlOrCmd: true, action: () => updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, settings.fontSize + FONT_SIZE_STEP) }) },
            { key: '-', ctrlOrCmd: true, action: () => updateSettings({ fontSize: Math.max(MIN_FONT_SIZE, settings.fontSize - FONT_SIZE_STEP) }) },
            { key: 'v', ctrlOrCmd: true, shift: true, action: () => focusedTabId && togglePreview(focusedTabId) },
            { key: ',', ctrlOrCmd: true, action: () => setSettingsModalOpen(true) },
            { ...kb('wordWrap', { key: 'z', ctrlOrCmd: false, alt: true }), action: () => updateSettings({ wordWrap: !settings.wordWrap }) },
            // F11 is the Windows/Linux convention; macOS uses its own system item.
            { key: 'F11', ctrlOrCmd: false, action: () => { void handleToggleFullScreen(); } },
            // Tab switching: Cmd/Ctrl+1-9
            ...([1,2,3,4,5,6,7,8,9].map(n => ({
                key: String(n),
                ctrlOrCmd: true,
                action: () => {
                    const idx = n - 1;
                    if (tabs[idx]) setActiveTabId(tabs[idx].id);
                },
            }))),
            // Tab cycling: Cmd+Tab / Cmd+Shift+Tab (on non-Mac use Alt+Tab-like)
            {
                key: 'Tab',
                ctrlOrCmd: !isMac,
                alt: isMac,
                action: () => {
                    if (tabs.length < 2) return;
                    const idx = tabs.findIndex(t => t.id === activeTabId);
                    setActiveTabId(tabs[(idx + 1) % tabs.length].id);
                },
            },
            {
                key: 'Tab',
                ctrlOrCmd: !isMac,
                alt: isMac,
                shift: true,
                action: () => {
                    if (tabs.length < 2) return;
                    const idx = tabs.findIndex(t => t.id === activeTabId);
                    setActiveTabId(tabs[(idx - 1 + tabs.length) % tabs.length].id);
                },
            },
        ];
    }

    useEffect(() => {
        // Read from the ref so the latest handlers/state are always used without
        // re-subscribing. Capture phase so our handler fires before Monaco's
        // internal handlers on Windows/WebView2, where Monaco may consume events
        // before they bubble.
        const handler = (e: KeyboardEvent) => {
            // Modal inputs (especially keybinding capture) own their keystrokes.
            // The listener runs in capture phase, so this guard must happen
            // before React receives the event.
            if (document.querySelector('.modal-overlay, .cp-overlay')) return;
            handleKeyDown(e, shortcutsRef.current);
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, []);

    // ─── Native menu event listeners (macOS) ───────────────────────────────

    useEffect(() => {
        let active = true;
        const cleanupFns: (() => void)[] = [];

        const setupListeners = async () => {
            const l = async (name: string, fn: (...args: unknown[]) => unknown) => {
                const unlisten = await listen(name, fn);
                if (active) cleanupFns.push(unlisten);
                else unlisten();
            };

            await l('menu-new', () => handlersRef.current?.createNewTab());
            await l('menu-open', () => handlersRef.current?.openFileFromDialog());
            await l('menu-open_folder', () => handlersRef.current?.handleOpenFolder());
            await l('menu-save', () => { const id = handlersRef.current?.activeTabId; if (id) handlersRef.current?.saveFile(id); });
            await l('menu-save_as', () => { const id = handlersRef.current?.activeTabId; if (id) handlersRef.current?.saveFileAs(id); });
            await l('menu-close', () => { const id = handlersRef.current?.activeTabId; if (id) handlersRef.current?.handleCloseTab(id); });
            await l('menu-find', () => handlersRef.current?.handleFind());
            await l('menu-replace', () => handlersRef.current?.handleReplace());
            await l('menu-find_in_files', () => setShowFindInFiles(v => !v));
            await l('menu-goto', () => setGoToLineModalOpen(true));
            await l('menu-format_document', () => handlersRef.current?.handleFormatDocument());
            await l('menu-toggle_theme', () => handlersRef.current?.handleToggleTheme());
            await l('menu-toggle_wrap', () => handlersRef.current?.handleToggleWordWrap());
            await l('menu-toggle_read_only', () => handlersRef.current?.handleToggleReadOnly());
            await l('menu-toggle_explorer', () => handlersRef.current?.toggleSidebar());
            await l('menu-copy_path', () => handlersRef.current?.handleCopyPath());
            await l('menu-preferences', () => setSettingsModalOpen(true));
            await l('menu-shortcuts', () => setKeybindingEditorOpen(true));
            await l('menu-revert_file', () => handlersRef.current?.handleRevertFile());
            await l('menu-about', () => setAboutModalOpen(true));

            const langs = [
                'plaintext', 'javascript', 'typescript', 'html', 'css', 'scss', 'sass', 'less',
                'json', 'xml', 'yaml', 'toml', 'ini', 'python', 'java', 'c', 'cpp', 'csharp',
                'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'r', 'lua', 'perl',
                'shell', 'powershell', 'bat', 'markdown', 'latex', 'sql', 'coffeescript',
                'handlebars', 'pug', 'razor', 'twig', 'dart', 'elixir', 'clojure', 'groovy',
                'haskell', 'julia', 'scheme', 'fsharp', 'objective-c', 'fortran', 'pascal',
                'ocaml', 'verilog', 'vhdl', 'solidity', 'graphql', 'redis', 'dockerfile', 'makefile',
            ];
            for (const lang of langs) {
                await l(`menu-lang-${lang}`, () => handlersRef.current?.handleChangeLanguage(lang));
            }

            await l('menu-toggle_split', () => handlersRef.current?.handleToggleSplitView());
            await l('menu-open_right_pane', () => handlersRef.current?.handleOpenInRightPane());
            await l('menu-swap_panes', () => handlersRef.current?.handleSwapPanes());
            await l('menu-toggle_preview', () => {
                const id = handlersRef.current?.activeTabId;
                if (id) handlersRef.current?.togglePreview(id);
            });

            await l('menu-recent-file', async (event: unknown) => {
                const path = (event as { payload: string }).payload;
                await handlersRef.current?.handleOpenRecent(path);
            });

            await l('open-file', async (event: unknown) => {
                const path = (event as { payload: string }).payload;
                try {
                    await handlersRef.current?.openFile(path);
                } catch (error) {
                    errorService.showError('Failed to open file', error as Error);
                }
            });

            await l('open-folder', async (event: unknown) => {
                const folder = (event as { payload: string }).payload;
                try {
                    // Set the folder directly — it was already validated on the Rust side
                    setOpenedFolder(folder);
                    await updateSettings({ openedFolder: folder, sidebarCollapsed: false });
                } catch (error) {
                    console.error('Failed to open folder from CLI:', error);
                }
            });

            // OS drag-and-drop is handled in Rust: it grants the dropped path
            // (which the renderer cannot do securely) and forwards it via the
            // open-file / open-folder events already handled above.
        };

        setupListeners();
        return () => { active = false; cleanupFns.forEach(fn => fn()); };
    }, [setOpenedFolder, updateSettings]);

    // ─── Drag-and-drop overlay ──────────────────────────────────────────────

    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
    const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragCounter(c => c + 1); };
    const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragCounter(c => Math.max(0, c - 1)); };
    const handleDrop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragCounter(0); };

    // ─── Command palette commands ───────────────────────────────────────────

    const allCommands = [
        // File
        { id: 'new-file',        label: 'New File',           description: 'Create a new untitled file',      category: 'File',    action: createNewTab },
        { id: 'open-file',       label: 'Open File',          description: 'Open a file from disk',           category: 'File',    action: openFileFromDialog },
        { id: 'open-folder',     label: 'Open Folder',        description: 'Open a workspace folder',         category: 'File',    action: handleOpenFolder },
        { id: 'save',            label: 'Save',               description: 'Save current file',               category: 'File',    action: () => focusedTabId && handleSave(focusedTabId) },
        { id: 'save-as',         label: 'Save As',            description: 'Save current file with new name', category: 'File',    action: () => focusedTabId && saveFileAs(focusedTabId) },
        { id: 'revert-file',     label: 'Revert File',        description: 'Reload file from disk',           category: 'File',    action: handleRevertFile },
        { id: 'close-tab',       label: 'Close Tab',          description: 'Close the current tab',           category: 'File',    action: () => focusedTabId && handleCloseTab(focusedTabId) },
        // Edit
        { id: 'find',            label: 'Find',               description: 'Find in current file',            category: 'Edit',    action: handleFind },
        { id: 'replace',         label: 'Find & Replace',     description: 'Find and replace in current file',category: 'Edit',    action: handleReplace },
        { id: 'find-in-files',   label: 'Find in Files',      description: 'Search across all files',         category: 'Edit',    action: () => setShowFindInFiles(v => !v) },
        { id: 'go-to-line',      label: 'Go to Line',         description: 'Jump to a specific line number',  category: 'Edit',    action: () => setGoToLineModalOpen(true) },
        // View
        { id: 'toggle-theme',    label: 'Toggle Theme',       description: 'Switch between light and dark',   category: 'View',    action: handleToggleTheme },
        { id: 'toggle-wrap',     label: 'Toggle Word Wrap',   description: 'Toggle line wrapping',            category: 'View',    action: handleToggleWordWrap },
        { id: 'toggle-readonly', label: 'Toggle Read-Only',   description: 'Toggle read-only mode',           category: 'View',    action: handleToggleReadOnly },
        { id: 'toggle-explorer', label: 'Toggle Explorer',    description: 'Show or hide file explorer',      category: 'View',    action: handleToggleSidebar },
        { id: 'toggle-split',    label: 'Toggle Split View',  description: 'Split editor side by side',       category: 'View',    action: handleToggleSplitView },
        { id: 'toggle-preview',  label: 'Toggle Markdown Preview', description: 'Preview markdown content',  category: 'View',    action: () => focusedTabId && togglePreview(focusedTabId) },
        { id: 'toggle-minimap',  label: 'Toggle Minimap',     description: 'Show or hide the minimap',        category: 'View',    action: () => updateSettings({ showMinimap: !settings.showMinimap }) },
        { id: 'copy-path',       label: 'Copy File Path',     description: 'Copy current file path',          category: 'View',    action: handleCopyPath },
        { id: 'toggle-fullscreen', label: 'Toggle Full Screen', description: 'Enter or exit full screen',     category: 'View',    action: () => { void handleToggleFullScreen(); } },
        { id: 'preferences',     label: 'Preferences',        description: 'Open editor settings',            category: 'Settings', action: () => setSettingsModalOpen(true) },
        { id: 'keybindings',     label: 'Keyboard Shortcuts', description: 'Edit keyboard shortcuts',         category: 'Settings', action: () => setKeybindingEditorOpen(true) },
        { id: 'diagnostics',    label: 'Show Diagnostics',   description: 'Session health and performance',  category: 'Help',     action: () => setShowDiagnostics(true) },
        // Data tools
        { id: 'json-format',     label: 'Format JSON',        description: 'Pretty-print JSON',               category: 'JSON',    action: () => { if (!focusedTab) return; try { updateTabContentAndAutosave(focusedTab.id, formatJson(focusedTab.content)); errorService.showSuccess('JSON formatted'); } catch (e) { errorService.showError('Invalid JSON', e as Error); } } },
        { id: 'json-minify',     label: 'Minify JSON',        description: 'Remove whitespace from JSON',     category: 'JSON',    action: () => { if (!focusedTab) return; try { updateTabContentAndAutosave(focusedTab.id, minifyJson(focusedTab.content)); } catch (e) { errorService.showError('Invalid JSON', e as Error); } } },
        { id: 'json-validate',   label: 'Validate JSON',      description: 'Check if JSON is valid',          category: 'JSON',    action: () => { if (!focusedTab) return; const r = validateJson(focusedTab.content); if (r.valid) { errorService.showSuccess('Valid JSON'); } else { errorService.showError(r.line ? `Invalid JSON at line ${r.line}: ${r.error}` : `Invalid JSON: ${r.error}`); } } },
        { id: 'json-sort-keys',  label: 'Sort JSON Keys',     description: 'Sort object keys alphabetically', category: 'JSON',    action: () => { if (!focusedTab) return; try { updateTabContentAndAutosave(focusedTab.id, sortJsonKeys(focusedTab.content)); } catch (e) { errorService.showError('Invalid JSON', e as Error); } } },
        { id: 'xml-format',      label: 'Format XML',         description: 'Format XML with indentation',     category: 'XML',     action: () => { if (!focusedTab) return; try { updateTabContentAndAutosave(focusedTab.id, formatXml(focusedTab.content)); } catch (e) { errorService.showError('Unable to format XML', e as Error); } } },
        { id: 'xml-validate',    label: 'Validate XML',       description: 'Check if XML is valid',           category: 'XML',     action: () => { if (!focusedTab) return; const r = validateXml(focusedTab.content); if (r.valid) { errorService.showSuccess('Valid XML'); } else { errorService.showError(`Invalid XML: ${r.error}`); } } },
        { id: 'yaml-format',     label: 'Format YAML',        description: 'Format YAML with indentation',    category: 'YAML',    action: () => { if (!focusedTab) return; try { updateTabContentAndAutosave(focusedTab.id, formatYaml(focusedTab.content)); } catch (e) { errorService.showError('Invalid YAML', e as Error); } } },
    ];

    if (isLoading) {
        return <div className="loading"><div>Loading...</div></div>;
    }

    const maxLine = focusedTab ? focusedTab.content.split('\n').length : 1;

    return (
        <div
            className="app"
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <DialogFocusManager />
            {availableUpdate && (
                <UpdateAvailableModal
                    update={availableUpdate}
                    onLater={dismissUpdate}
                    onSkip={dismissUpdate}
                />
            )}
            {!isMac && (
                <MenuBar
                    onNew={createNewTab}
                    onOpen={openFileFromDialog}
                    onOpenFolder={handleOpenFolder}
                    onSave={() => focusedTabId && handleSave(focusedTabId)}
                    onSaveAs={() => focusedTabId && saveFileAs(focusedTabId)}
                    onClose={() => focusedTabId && handleCloseTab(focusedTabId)}
                    onRevertFile={handleRevertFile}
                    onUndo={handleUndo}
                    onRedo={handleRedo}
                    onCut={handleCut}
                    onCopy={handleCopy}
                    onPaste={handlePaste}
                    onSelectAll={handleSelectAll}
                    onToggleLineComment={handleToggleLineComment}
                    onFormatDocument={handleFormatDocument}
                    onFind={handleFind}
                    onFindInFiles={() => setShowFindInFiles(v => !v)}
                    onReplace={handleReplace}
                    onGoToLine={() => setGoToLineModalOpen(true)}
                    onCommandPalette={() => setCommandPaletteOpen(true)}
                    onToggleTheme={handleToggleTheme}
                    onToggleWordWrap={handleToggleWordWrap}
                    onToggleReadOnly={handleToggleReadOnly}
                    onTogglePreview={() => focusedTabId && togglePreview(focusedTabId)}
                    onOpenSettings={() => setSettingsModalOpen(true)}
                    onOpenKeybindings={() => setKeybindingEditorOpen(true)}
                    onToggleExplorer={handleToggleSidebar}
                    onToggleSplitView={handleToggleSplitView}
                    onOpenInRightPane={handleOpenInRightPane}
                    onSwapPanes={handleSwapPanes}
                    onChangeLanguage={handleChangeLanguage}
                    currentLanguage={focusedTab?.language ?? null}
                    onCopyPath={handleCopyPath}
                    onToggleFullScreen={handleToggleFullScreen}
                    isFullscreen={isFullscreen}
                    recentFiles={recentFiles}
                    onOpenRecent={handleOpenRecent}
                    settings={settings}
                    hasActiveTab={focusedTab !== null}
                    isReadOnly={focusedTab?.isReadOnly || false}
                    isPreview={focusedTab?.isPreview || false}
                    activeTabPath={focusedTab?.path || null}
                    splitViewEnabled={splitViewEnabled}
                    hasRightPane={rightPaneTabId !== null}
                    hasSavedPath={!!focusedTab?.path}
                    windowTitle={windowTitle}
                    onAbout={() => setAboutModalOpen(true)}
                />
            )}

            <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onTabClick={(tabId) => {
                    // When split view is active and the right pane has focus,
                    // route the click into the right pane instead of the left.
                    if (splitViewEnabled && activePaneRef.current === 'right') {
                        openInRightPane(tabId);
                    } else {
                        setActiveTabId(tabId);
                    }
                }}
                onTabClose={handleCloseTab}
                onNewTab={createNewTab}
                onReorder={reorderTabs}
                onRename={renameFile}
                onPinToggle={togglePinTab}
                onToggleSplitView={handleToggleSplitView}
                splitViewEnabled={splitViewEnabled}
                onTogglePreview={() => focusedTabId && togglePreview(focusedTabId)}
                isPreview={focusedTab?.isPreview || false}
                canPreview={focusedTab !== null}
            />

            <div className="app-main">
                {/* Sidebar: Find in Files always shows when toggled on (even if the
                    Explorer sidebar is collapsed); otherwise the Explorer respects collapse. */}
                {showFindInFiles ? (
                    <FindInFiles
                        folderPath={openedFolder}
                        width={sidebarWidth}
                        onOpenFile={handleOpenFileAtLine}
                        onOpenFolder={async () => {
                            const path = await openFolder();
                            if (path) await updateSettings({ openedFolder: path, sidebarCollapsed: false });
                        }}
                        onClose={() => setShowFindInFiles(false)}
                    />
                ) : !sidebarCollapsed ? (
                    <FileExplorer
                        folderPath={openedFolder}
                        onFolderOpen={(path) => {
                            setOpenedFolder(path);
                            void updateSettings({ openedFolder: path, sidebarCollapsed: false });
                        }}
                        onFileSelect={handleFileSelect}
                        activePath={focusedTab?.path ?? null}
                        dirtyPaths={dirtyPaths}
                        onClose={handleCloseFolder}
                        collapsed={sidebarCollapsed}
                        width={sidebarWidth}
                        onWidthChange={handleSidebarWidthChange}
                    />
                ) : null}

                <div className="app-content">
                    {focusedTab?.path && (
                        <Breadcrumb
                            path={focusedTab.path}
                            lineCount={focusedTab.content.split('\n').length}
                        />
                    )}

                    {focusedTab && focusedTab.externallyModified && (
                        <ExternalChangePrompt
                            tabId={focusedTab.id}
                            fileName={focusedTab.path?.split(/[/\\]/).pop() || 'Untitled'}
                            changeCount={focusedTab.externalChangeCount}
                            isDeleted={!!focusedTab.path && fileWatcher.isPendingDeletion(focusedTab.path)}
                            onReload={() => {
                                if (focusedTab.path && fileWatcher.isPendingDeletion(focusedTab.path)) {
                                    void saveFile(focusedTab.id);
                                } else {
                                    void reloadFileFromDisk(focusedTab.id).catch(error => {
                                        errorService.showError('Failed to reload file', error as Error);
                                    });
                                }
                            }}
                            onIgnore={() => ignoreExternalChange(focusedTab.id)}
                        />
                    )}

                    {tabs.length === 0 ? (
                        <WelcomeScreen
                            onNewFile={createNewTab}
                            onOpenFile={openFileFromDialog}
                            onOpenFolder={handleOpenFolder}
                            recentFiles={recentFiles}
                            onOpenRecent={handleOpenRecent}
                        />
                    ) : activeTab ? (
                        <div id="editor-workspace" className="editor-wrapper" style={{ position: 'relative' }}>
                            <FindReplaceBar
                                isOpen={findOpen}
                                showReplace={findShowReplace}
                                onClose={() => setFindOpen(false)}
                                getEditor={getActiveEditor}
                                getPreviewElement={getPreviewElement}
                                previewActive={!!activeTab.isPreview}
                            />
                            {splitViewEnabled && rightPaneTabId ? (
                                <SplitView
                                    leftTab={activeTab}
                                    rightTab={tabs.find(t => t.id === rightPaneTabId) || null}
                                    settings={{ ...settings, editorTheme: effectiveEditorTheme }}
                                    findKeybinding={settings.keybindings['find']}
                                    replaceKeybinding={settings.keybindings['replace']}
                                    onLeftChange={(content) => updateTabContentAndAutosave(activeTab.id, content)}
                                    onRightChange={(content) => { if (rightPaneTabId) updateTabContentAndAutosave(rightPaneTabId, content); }}
                                    onLeftCursorChange={(line, col) => updateCursorPosition(activeTab.id, line, col)}
                                    onRightCursorChange={(line, col) => { if (rightPaneTabId) updateCursorPosition(rightPaneTabId, line, col); }}
                                    onLeftScrollChange={(top, left) => updateScrollPosition(activeTab.id, top, left)}
                                    onRightScrollChange={(top, left) => { if (rightPaneTabId) updateScrollPosition(rightPaneTabId, top, left); }}
                                    onLeftSelectionChange={(len) => { if (activePaneRef.current === 'left') setSelectionLength(len); }}
                                    onRightSelectionChange={(len) => { if (activePaneRef.current === 'right') setSelectionLength(len); }}
                                    onLeftEditorReady={setLeftEditorInstance}
                                    onRightEditorReady={setRightEditorInstance}
                                    onLeftFocus={() => { activePaneRef.current = 'left'; setActivePane('left'); }}
                                    onRightFocus={() => { activePaneRef.current = 'right'; setActivePane('right'); }}
                                />
                            ) : activeTab.isPreview ? (
                                <MarkdownPreview content={activeTab.content} bodyRef={previewBodyRef} />
                            ) : (
                                <EditorPanel
                                    modelPath={modelUriForTab(activeTab.id)}
                                    content={activeTab.content}
                                    language={activeTab.language}
                                    editorTheme={effectiveEditorTheme}
                                    fontSize={settings.fontSize}
                                    fontFamily={settings.fontFamily}
                                    wordWrap={settings.wordWrap}
                                    showMinimap={settings.showMinimap}
                                    isReadOnly={activeTab.isReadOnly}
                                    enableColumnSelection={settings.enableColumnSelection}
                                    tabSize={settings.tabSize}
                                    insertSpaces={settings.insertSpaces}
                                    cursorLine={activeTab.cursorLine}
                                    cursorColumn={activeTab.cursorColumn}
                                    scrollTop={activeTab.scrollTop}
                                    scrollLeft={activeTab.scrollLeft}
                                    findKeybinding={settings.keybindings['find']}
                                    replaceKeybinding={settings.keybindings['replace']}
                                    onChange={(content) => updateTabContentAndAutosave(activeTab.id, content)}
                                    onCursorChange={(line, col) => updateCursorPosition(activeTab.id, line, col)}
                                    onScrollChange={(top, left) => updateScrollPosition(activeTab.id, top, left)}
                                    onSelectionChange={setSelectionLength}
                                    onEditorReady={setLeftEditorInstance}
                                    onFocus={() => { activePaneRef.current = 'left'; setActivePane('left'); }}
                                />
                            )}
                        </div>
                    ) : null}

                </div>
            </div>

            {/* Outside .app-main so the bar spans the whole window, running under
                the sidebar as well as the editor — as in the design. */}
            {focusedTab && (
                <StatusBar
                    line={focusedTab.cursorLine}
                    column={focusedTab.cursorColumn}
                    language={focusedTab.language}
                    encoding={focusedTab.encoding}
                    eol={focusedTab.eol}
                    fileSize={focusedTab.content.length}
                    content={focusedTab.content}
                    selectionLength={selectionLength}
                    fontSize={settings.fontSize}
                    showMinimap={settings.showMinimap}
                    onZoomIn={() => updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, settings.fontSize + FONT_SIZE_STEP) })}
                    onZoomOut={() => updateSettings({ fontSize: Math.max(MIN_FONT_SIZE, settings.fontSize - FONT_SIZE_STEP) })}
                    onToggleMinimap={() => updateSettings({ showMinimap: !settings.showMinimap })}
                    onChangeLanguage={() => setCommandPaletteOpen(true)}
                />
            )}

            <GoToLineModal isOpen={goToLineModalOpen} onClose={() => setGoToLineModalOpen(false)} onGoToLine={handleGoToLine} maxLine={maxLine} />
            <SettingsModal isOpen={settingsModalOpen} onClose={() => setSettingsModalOpen(false)} settings={settings} onSave={updateSettings} />
            <CommandPalette isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} commands={allCommands} />
            <KeybindingEditor isOpen={keybindingEditorOpen} onClose={() => setKeybindingEditorOpen(false)} keybindings={settings.keybindings} onSave={(keybindings) => updateSettings({ keybindings })} />

            {appCloseModalOpen && (
                <div className="modal-overlay" onClick={handleCancelQuit}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-title-group">
                                <span className="modal-icon-badge warning" aria-hidden="true" />
                                <h3>Unsaved changes</h3>
                            </div>
                        </div>
                        <div className="modal-body indented">
                            <p>You have unsaved changes. Do you want to save them before quitting?</p>
                        </div>
                        <div className="modal-footer">
                            <button className="modal-button danger" onClick={handleQuitWithoutSaving}>Don't Save</button>
                            <button className="modal-button" onClick={handleCancelQuit}>Cancel</button>
                            <button className="modal-button primary" onClick={handleSaveAllAndQuit} autoFocus>Save All &amp; Quit</button>
                        </div>
                    </div>
                </div>
            )}

            {aboutModalOpen && (
                <div className="modal-overlay" onClick={() => setAboutModalOpen(false)}>
                    <div className="modal about-modal" onClick={e => e.stopPropagation()}>
                        <div className="about-modal-content">
                            <img src="/app-icon.png" alt="ZITEXT" className="about-modal-icon" />
                            <h2 className="about-modal-name">ZITEXT Editor</h2>
                            <p className="about-modal-version">Version {appVersion}</p>
                            <p className="about-modal-desc">Fast, local-first text and code editor</p>
                            <p className="about-modal-copy">© {new Date().getFullYear()} Zitrino. All rights reserved.</p>
                        </div>
                        <div className="modal-actions">
                            <button className="modal-btn" onClick={handleOpenReleaseNotes}>Release notes</button>
                            <button className="modal-btn modal-btn-primary" onClick={() => setAboutModalOpen(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {dragCounter > 0 && (
                <div className="drag-overlay">
                    <div className="drag-overlay-content">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="drag-overlay-icon">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <div className="drag-overlay-text">Drop files to open</div>
                    </div>
                </div>
            )}

            <UnsavedChangesModal
                isOpen={unsavedChangesModalOpen}
                fileName={pendingCloseTabId ? (tabs.find(t => t.id === pendingCloseTabId)?.title || 'Untitled') : 'Untitled'}
                onSave={handleSaveAndClose}
                onDontSave={handleDontSaveAndClose}
                onCancel={handleCancelClose}
            />

            <DiagnosticsPanel
                isOpen={showDiagnostics}
                onClose={() => setShowDiagnostics(false)}
                tabCount={tabs.length}
            />

            <ToastContainer />
        </div>
    );
}

export default App;
