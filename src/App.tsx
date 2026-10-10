import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { ask } from '@tauri-apps/plugin-dialog';
import { MenuBar } from './components/MenuBar';
import { TabBar } from './components/TabBar';
import { EditorPanel } from './components/EditorPanel';
import { LazyMarkdownPreview as MarkdownPreview } from './components/LazyMarkdownPreview';
import { SplitView } from './components/SplitView';
import { StatusBar } from './components/StatusBar';
import { Breadcrumb } from './components/Breadcrumb';
import { FileExplorer } from './components/FileExplorer';
import { ExternalChangePrompt } from './components/ExternalChangePrompt';
import { CommandPalette } from './components/CommandPalette';
import { ToastContainer } from './components/ToastContainer';
import { WelcomeScreen } from './components/WelcomeScreen';
import { UnsavedChangesModal } from './components/UnsavedChangesModal';
import { useUpdateChecker } from './hooks/useUpdateChecker';
import { initCrashReporter } from './utils/crashReporter';
import { startTimer } from './utils/perfMetrics';
import { startSession, endSession } from './utils/sessionHealth';
import { FindReplaceBar } from './components/FindReplaceBar';
import { DialogFocusManager } from './components/DialogFocusManager';
import { useEditorState } from './state/useEditorState';
import { useProjectState } from './state/useProjectState';
import { useAutosave } from './state/useAutosave';
import { PaneErrorBoundary } from './components/PaneErrorBoundary';
import { handleKeyDown, isBrowserNavigationKey, isMac, type ShortcutHandler } from './utils/shortcuts';
import { bindingFor } from './utils/commandRegistry';
import { useResolvedTheme, readToken } from './utils/theme';
import { countLines, getLastSession, getRecentFiles, rebuildNativeMenu } from './utils/fileOperations';
import { validateJson } from './utils/jsonTools';
import { formatXml, validateXml } from './utils/xmlYamlTools';
import { runHeavyTaskOffThread } from './utils/heavyTasks';
import type { HeavyTask } from './utils/heavyTaskRunner';
import { applyDataTransform, applyDataTransformAsync } from './utils/dataTransform';
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
import { markOpenListenersReady } from './utils/openRequests';
import { canPreviewMarkdown, isJsoncPath, LANGUAGES, showsPreview } from './utils/languages';
import { windowCaption } from './utils/windowTitle';
import { shouldFormatOnSave } from './utils/dataTransform';
import { fileNameOf, newViewId, onDocumentOpened, onLargeFileRequest, type CompareSide, type ViewCommands, type WorkspaceView } from './utils/workspaceViews';
import type { ResolvedSide } from './components/CompareView';
import type { Tab } from './types';
import type { ViewTab } from './components/TabBar';
import { openFileDialog, readFileContent } from './utils/fileOperations';
import { TEXT_TOOLS, TEXT_TOOLS_CATEGORY, type TextToolId } from './utils/textToolList';
import { addMark, clearMarks, lastFindQuery, markProblem, marksOf, nextMarked, onMarkProblem, onMarksChanged, removeMark, type MarkQuery } from './utils/marks';
import { flushScratchpadBeforeQuit, scratchpadSaveProblem } from './utils/scratchpad';

/**
 * Before quitting: the Scratchpad's last keystrokes are written, and if its
 * text can't be saved (over 5 MB, disk full), the user decides whether to
 * quit anyway. True means quit.
 */
async function scratchpadReadyToQuit(): Promise<boolean> {
    const flushed = await flushScratchpadBeforeQuit();
    const problem = scratchpadSaveProblem()
        ?? (flushed === 'pending' ? 'saving is taking longer than expected (the disk may be busy).' : null);
    if (!problem) return true;
    return ask(
        `The Scratchpad's latest text couldn't be saved: ${problem}\n\nIf you quit now, that text is lost.`,
        { title: 'Scratchpad not saved', kind: 'warning', okLabel: 'Quit Anyway', cancelLabel: 'Cancel' },
    );
}
import type { PromptRequest } from './components/InputPrompt';
import { checkRegexSpeed } from './utils/heavyTasks';

// Loaded on first use; it stays mounted (hidden) afterwards.
const FindInFiles = lazy(() => import('./components/FindInFiles').then(module => ({ default: module.FindInFiles })));
// Dialogs opened now and then load on first open, keeping startup light.
const SettingsModal = lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const KeybindingEditor = lazy(() => import('./components/KeybindingEditor').then(module => ({ default: module.KeybindingEditor })));
const UpdateAvailableModal = lazy(() => import('./components/UpdateAvailableModal').then(module => ({ default: module.UpdateAvailableModal })));
const GoToLineModal = lazy(() => import('./components/GoToLineModal').then(module => ({ default: module.GoToLineModal })));
const DiagnosticsPanel = lazy(() => import('./components/DiagnosticsPanel').then(module => ({ default: module.DiagnosticsPanel })));
// The Large File / Log viewer and File Compare load when first opened.
const LogViewer = lazy(() => import('./components/LogViewer').then(module => ({ default: module.LogViewer })));
const CompareView = lazy(() => import('./components/CompareView').then(module => ({ default: module.CompareView })));
const ScratchpadView = lazy(() => import('./components/ScratchpadView').then(module => ({ default: module.ScratchpadView })));
const InputPrompt = lazy(() => import('./components/InputPrompt').then(module => ({ default: module.InputPrompt })));
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import './styles.css';

/* Must stay on zitext.com: open_url_in_browser rejects any other host. */
const RELEASE_NOTES_URL = 'https://zitext.com/changelog';

interface HandlersRef {
    createNewTab: () => string;
    openFile: (path: string, line?: number, col?: number, scrollTop?: number, scrollLeft?: number, skipMenu?: boolean) => Promise<string | null>;
    openRequestedFile: (path: string) => Promise<string | null>;
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
    /** The Large File / Log or Compare view on screen, if any. */
    shownViewId: string | null;
    closeView: (id: string) => void;
    runViewCommand: (name: keyof ViewCommands) => void;
    openGoToLine: () => void;
    openLogView: (path?: string) => Promise<void>;
    compareFocusedWith: (source: 'file' | 'clipboard' | 'saved') => Promise<void>;
    openCompareTabPicker: () => void;
    openScratchpad: () => void;
    openTextTools: () => void;
    markSelection: () => void;
    markFindMatches: () => void;
    jumpToMark: (backwards: boolean) => void;
    clearAllMarks: () => void;
    promptMark: (regex: boolean) => void;
}

/** A view's name in the tab bar and window title. */
function viewTitle(view: WorkspaceView, tabs: Tab[]): string {
    if (view.kind === 'log' || view.kind === 'scratchpad') return view.title;
    const name = (side: CompareSide) => side.kind === 'snapshot'
        ? side.label
        : tabs.find(tab => tab.id === side.tabId)?.title ?? 'Closed document';
    return `${name(view.left)} ↔ ${name(view.right)}`;
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
        openRequestedFile,
        getTabContent,
        requestReveal,
        startupFolder,
        clearStartupFolder,
        openFileFromDialog,
        saveFile,
        saveFileAs,
        closeTab,
        beginClose,
        cancelClose,
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
    const { update: availableUpdate, dismiss: dismissUpdate, skip: skipUpdate } = useUpdateChecker(settings.checkForUpdates);

    // UI state
    const [goToLineModalOpen, setGoToLineModalOpen] = useState(false);
    const [settingsModalOpen, setSettingsModalOpen] = useState(false);
    const [aboutModalOpen, setAboutModalOpen] = useState(false);
    const [appVersion, setAppVersion] = useState('');
    useEffect(() => { getVersion().then(setAppVersion); }, []);
    const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
    const [commandPaletteQuery, setCommandPaletteQuery] = useState('');
    const [keybindingEditorOpen, setKeybindingEditorOpen] = useState(false);
    const [recentFiles, setRecentFiles] = useState<string[]>([]);
    const recentFilesRef = useRef<string[]>([]);
    const [dragCounter, setDragCounter] = useState(0);
    const [unsavedChangesModalOpen, setUnsavedChangesModalOpen] = useState(false);
    const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
    const [showFindInFiles, setShowFindInFiles] = useState(false);
    // Mounted on first use, then kept (hidden) so its results survive.
    const [findInFilesUsed, setFindInFilesUsed] = useState(false);
    useEffect(() => { if (showFindInFiles) setFindInFilesUsed(true); }, [showFindInFiles]);
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [appCloseModalOpen, setAppCloseModalOpen] = useState(false);
    const closeRequestTokenRef = useRef<string | null>(null);
    /** A quit is being decided (Scratchpad saving or asking). */
    const quitFlowRef = useRef(false);

    // Editor instances + active pane tracking
    const [leftEditorInstance, setLeftEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
    const [rightEditorInstance, setRightEditorInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
    const activePaneRef = useRef<'left' | 'right'>('left');
    const [activePane, setActivePane] = useState<'left' | 'right'>('left');
    const [selectionLength, setSelectionLength] = useState(0);

    // Large File / Log and Compare views (utils/workspaceViews). A view is on
    // screen while the document tab that was active when it was opened (or
    // clicked) is still the active one: choosing a tab, or opening a file
    // (which activates its tab), brings the editor back.
    const [views, setViews] = useState<WorkspaceView[]>([]);
    const [activeView, setActiveView] = useState<{ id: string; tabId: string | null } | null>(null);
    const shownView = activeView && activeView.tabId === activeTabId
        ? views.find(view => view.id === activeView.id) ?? null
        : null;
    const viewsRef = useRef(views);
    viewsRef.current = views;
    const activeTabIdRef = useRef(activeTabId);
    activeTabIdRef.current = activeTabId;
    const viewCommandsRef = useRef<ViewCommands | null>(null);
    const registerViewCommands = useCallback((commands: ViewCommands | null) => { viewCommandsRef.current = commands; }, []);

    // The tab that currently has focus (left pane unless split view + right pane
    // is focused). None while a view is on screen, so tab commands (Save, Close
    // Tab, the data tools…) can't act on a document that isn't visible.
    const focusedTabId = shownView ? null : splitViewEnabled && activePane === 'right' ? rightPaneTabId : activeTabId;
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
            // Tell the backend this window is alive and handling the request;
            // an unacknowledged request lets the user force-quit natively.
            void invoke('acknowledge_close_request', { token: event.payload }).catch(() => {});
            closeRequestTokenRef.current = event.payload;
            if (tabsRef.current.some(t => t.isDirty)) {
                setAppCloseModalOpen(true);
            } else if (!quitFlowRef.current) {
                // The Scratchpad saves as you type; its last keystrokes are
                // written (or the user asked) before the window goes. A
                // second close request meanwhile only updates the token,
                // which this flow answers.
                quitFlowRef.current = true;
                void scratchpadReadyToQuit()
                    .then(quit => finishQuitRef.current(quit))
                    .finally(() => { quitFlowRef.current = false; });
            }
        }).then((u) => { if (cancelled) u(); else unlisten = u; });
        return () => { cancelled = true; if (unlisten) unlisten(); };
    }, []);

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
                    // Background save: never prompts. A conflict pauses
                    // autosave for that tab and raises its change banner.
                    allSaved = await saveFile(tab.id, undefined, { background: true }) && allSaved;
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
    // Keyed on the list itself, so the Set (and the memoized explorer) only
    // changes when a file's unsaved state does, not on every keystroke.
    const dirtyPathKey = tabs.filter(t => t.isDirty && t.path).map(t => t.path as string).join('\n');
    const dirtyPaths = useMemo(
        () => new Set(dirtyPathKey ? dirtyPathKey.split('\n') : []),
        [dirtyPathKey],
    );

    // Caption for the titlebar: "file — project", per the design. It names the
    // focused pane's tab, as the tab bar does ("Untitled-3").
    const focusedTabPath = focusedTab?.path ?? null;
    const focusedTabTitle = focusedTab?.title ?? null;
    const shownViewTitle = shownView ? viewTitle(shownView, tabs) : null;
    const windowTitle = useMemo(
        () => shownViewTitle
            ?? windowCaption(focusedTabTitle === null ? null : { path: focusedTabPath, title: focusedTabTitle }, openedFolder),
        [shownViewTitle, focusedTabPath, focusedTabTitle, openedFolder],
    );

    // The OS window title is the same caption the custom titlebar draws, so the
    // three platforms read identically. Only Windows runs undecorated and paints
    // its own bar; macOS and Linux show this one, and previously it was a
    // different string ("file - ZITEXT Editor"), which no one noticed on Windows
    // because the native titlebar is hidden there.
    //
    // The dirty marker stays: a window list is where an unsaved file is easiest
    // to miss, and the tab bar carries its own dot regardless.
    useEffect(() => {
        const dirty = focusedTab?.isDirty ? '● ' : '';
        getCurrentWindow()
            .setTitle(`${dirty}${windowTitle}`)
            .catch(() => { /* no window title on platforms without one */ });
    }, [windowTitle, focusedTab?.isDirty]);

    // Closing or replacing the project folder ends the app's access to it;
    // files still open from it keep exact access so they can be saved.
    const grantedFolderRef = useRef<string | null>(null);
    useEffect(() => {
        const previous = grantedFolderRef.current;
        grantedFolderRef.current = openedFolder;
        if (!previous || previous === openedFolder) return;
        const keepPaths = tabsRef.current.flatMap(t => t.path ? [t.path] : []);
        invoke('release_folder_access', { folder: previous, keepPaths })
            .catch(error => console.warn('Could not release folder access:', error));
    }, [openedFolder]);

    // ─── Active pane helpers ────────────────────────────────────────────────

    const shownViewId = shownView?.id ?? null;
    const getActiveEditor = useCallback(() => {
        // A view on screen: its own editor (File Compare), or none.
        if (shownViewId) return viewCommandsRef.current?.activeEditor?.() ?? null;
        if (splitViewEnabled && activePane === 'right') {
            return rightEditorInstance;
        }
        return leftEditorInstance;
    }, [shownViewId, splitViewEnabled, activePane, leftEditorInstance, rightEditorInstance]);

    // The rendered Markdown body, so Find can search the preview in place rather
    // than forcing the tab back to source view.
    // Rendered Markdown previews, so Find can search the focused document's
    // preview: the single view or the left pane, and the right pane.
    const previewBodyRef = useRef<HTMLDivElement>(null);
    const rightPreviewBodyRef = useRef<HTMLDivElement>(null);
    const focusedPaneIsRight = splitViewEnabled && activePane === 'right';
    const getPreviewElement = useCallback(
        () => (focusedPaneIsRight ? rightPreviewBodyRef.current : previewBodyRef.current),
        [focusedPaneIsRight],
    );

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

    // Re-entry guard for the dialog Save buttons: a double click (or Enter
    // pressed twice on the focused button) must not start a second save, which
    // could otherwise run after the tab is closed.
    const closeSaveInFlightRef = useRef(false);

    const handleSaveAndClose = async () => {
        const id = pendingCloseTabId;
        if (!id || closeSaveInFlightRef.current) return;
        closeSaveInFlightRef.current = true;
        try {
            const saved = await handleSave(id);
            // Only close once the save actually succeeded. If the user cancelled the
            // Save-As dialog (or the write failed), keep the tab so content isn't lost.
            if (!saved) return;
            closeTab(id);
            setUnsavedChangesModalOpen(false);
            setPendingCloseTabId(null);
        } finally {
            closeSaveInFlightRef.current = false;
        }
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
        const tab = tabs.find(candidate => candidate.id === tabId);
        // Format on Save never changes a read-only document. XML and YAML use
        // the app's own formatters (Monaco has none for them); if one refuses
        // (invalid input, or a value it would not keep exactly), the file is
        // saved as it is. An untitled document is not formatted: its save
        // starts with a Save As dialog that may be cancelled, which used to
        // leave the document reformatted but unsaved.
        if (tab && shouldFormatOnSave(tab, settings.formatOnSave)) {
            if (tab.language === 'xml' || tab.language === 'yaml') {
                // YAML is formatted in the background; XML needs
                // the browser's XML parser, so it stays on this thread.
                const result = tab.language === 'xml'
                    ? applyDataTransform(tab, text => formatXml(text, settings.tabSize))
                    : await applyDataTransformAsync(
                        tab,
                        text => runHeavyTaskOffThread({ kind: 'formatYaml', text, indent: settings.tabSize }),
                        () => getTabContent(tabId),
                    );
                if (result.kind === 'changed') {
                    updateTabContentAndAutosave(tabId, result.content);
                    contentOverride = result.content;
                }
            } else {
                contentOverride = await formatTabContent(tabId);
            }
        }
        // Manual save (Ctrl+S / File > Save / save-on-close) — advances the
        // revert baseline, unlike autosave which calls saveFile directly.
        return await saveFile(tabId, contentOverride, { manual: true });
    }, [settings.formatOnSave, settings.tabSize, tabs, formatTabContent, saveFile, updateTabContentAndAutosave, getTabContent]);

    // ─── App-close (quit) with unsaved-changes prompt ───────────────────────

    const handleSaveAllAndQuit = async () => {
        if (closeSaveInFlightRef.current) return;
        closeSaveInFlightRef.current = true;
        try {
            await saveAllAndQuit();
        } finally {
            closeSaveInFlightRef.current = false;
        }
    };

    const saveAllAndQuit = async () => {
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
        await quitAfterScratchpad();
    };

    /**
     * Answers the latest close request: quits, or (quit === false) keeps the
     * app open. The token is read only now, after any waiting, so a close
     * request that arrived meanwhile is the one answered. If the backend
     * refuses (the request was replaced), snapshots resume.
     */
    const finishQuit = async (quit: boolean) => {
        const token = closeRequestTokenRef.current;
        closeRequestTokenRef.current = null;
        if (!token) return;
        if (!quit) {
            await invoke('cancel_app_close', { token }).catch(() => { /* request already expired */ });
            return;
        }
        beginClose();
        await invoke('confirm_app_close', { token }).catch(() => cancelClose());
    };
    const finishQuitRef = useRef(finishQuit);
    finishQuitRef.current = finishQuit;

    /** Ends the confirmed quit, unless the Scratchpad's text can't be saved
     *  and the user keeps the app open. ("Don't Save" is about documents;
     *  the Scratchpad is always kept.) */
    const quitAfterScratchpad = async () => {
        setAppCloseModalOpen(false);
        if (!closeRequestTokenRef.current) return;
        await finishQuit(await scratchpadReadyToQuit());
    };

    const handleQuitWithoutSaving = async () => {
        await quitAfterScratchpad();
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
        if (focusedTab && showsPreview(focusedTab)) togglePreview(focusedTab.id);
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

    const handleGoToLine = (lineNumber: number, column: number) => {
        if (focusedTab) requestReveal(focusedTab.id, lineNumber, column);
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

    // Stable callbacks: the explorer is memoized.
    const handleFileSelect = useCallback(async (path: string) => {
        try {
            await openFile(path);
        } catch (error) {
            errorService.showError('Failed to open file', error as Error);
        }
    }, [openFile]);

    const handleCloseFolder = useCallback(async () => {
        closeFolder();
        await updateSettings({ openedFolder: null, sidebarCollapsed: true });
    }, [closeFolder, updateSettings]);

    const handleExplorerFolderOpen = useCallback((path: string) => {
        setOpenedFolder(path);
        void updateSettings({ openedFolder: path, sidebarCollapsed: false });
    }, [setOpenedFolder, updateSettings]);

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
                await writeClipboardText(focusedTab.path);
                errorService.showSuccess('File path copied to clipboard');
            } catch (error) {
                errorService.showError('Failed to copy file path', error as Error);
            }
        }
    };

    // Opening a search result keeps the panel open (to visit the next match)
    // and asks the editor to show the line once the document is in view.
    const handleOpenFileAtLine = async (path: string, line: number) => {
        try {
            const tabId = await openFile(path, line, 1, 0, 0);
            if (tabId) requestReveal(tabId, line, 1);
        } catch (error) {
            errorService.showError('Failed to open file', error as Error);
        }
    };

    // ─── Large File / Log and Compare views ─────────────────────────────────

    const showView = useCallback((id: string, tabId: string | null = activeTabIdRef.current) => {
        setActiveView({ id, tabId });
    }, []);

    const closeView = useCallback((id: string) => {
        setViews(current => current.filter(view => view.id !== id));
        setActiveView(current => (current?.id === id ? null : current));
    }, []);

    const openLogView = useCallback(async (path?: string) => {
        const target = path ?? await openFileDialog();
        if (!target) return;
        const existing = viewsRef.current.find(view => view.kind === 'log' && view.path === target);
        if (existing) {
            showView(existing.id);
            return;
        }
        const id = newViewId();
        setViews(current => [...current, { id, kind: 'log', path: target, title: fileNameOf(target) }]);
        showView(id);
    }, [showView]);

    // A file too large for the editor offers the viewer (useFileManager).
    useEffect(() => onLargeFileRequest(path => { void handlersRef.current?.openLogView(path); }), []);
    // Opening a document shows it, even one that is already the active tab.
    useEffect(() => onDocumentOpened(() => setActiveView(null)), []);

    /** Compares the focused document (right) with another source (left). */
    const compareFocusedWith = async (source: 'file' | 'clipboard' | 'saved' | { tabId: string }) => {
        const current = focusedTab;
        if (!current) {
            errorService.showWarning('Open the document you want to compare first.');
            return;
        }
        const right: CompareSide = { kind: 'tab', tabId: current.id };
        const open = (left: CompareSide) => {
            const id = newViewId();
            const tabId = activeTabIdRef.current;
            setViews(views => [...views, { id, kind: 'compare', left, right, title: '' }]);
            showView(id, tabId);
        };
        if (source === 'file') {
            const path = await openFileDialog();
            if (!path) return;
            const keepActive = activeTabIdRef.current;
            const otherId = await openFile(path);
            if (!otherId) return;
            // Opening the file made its tab active; the comparison is shown
            // from the document it was started from.
            if (keepActive) setActiveTabId(keepActive);
            if (otherId === current.id) {
                errorService.showWarning('That is the document being compared. Choose a different file.');
                return;
            }
            const id = newViewId();
            setViews(views => [...views, { id, kind: 'compare', left: { kind: 'tab', tabId: otherId }, right, title: '' }]);
            showView(id, keepActive);
        } else if (source === 'clipboard') {
            let text: string | null = null;
            try { text = await readClipboardText(); } catch { /* treated as empty */ }
            if (!text) {
                errorService.showWarning('The clipboard has no text to compare.');
                return;
            }
            open({ kind: 'snapshot', label: 'Clipboard', text });
        } else if (source === 'saved') {
            if (!current.path) {
                errorService.showWarning('This document has never been saved, so there is no version on disk to compare with.');
                return;
            }
            try {
                const saved = await readFileContent(current.path);
                open({ kind: 'snapshot', label: `${current.title} (on disk)`, text: saved.content });
            } catch (error) {
                errorService.showError('Could not read the saved version', error as Error);
            }
        } else {
            if (source.tabId === current.id) return;
            open({ kind: 'tab', tabId: source.tabId });
        }
    };

    const swapCompareSides = useCallback((id: string) => {
        setViews(current => current.map(view => view.id === id && view.kind === 'compare'
            ? { ...view, left: view.right, right: view.left }
            : view));
    }, []);

    // A comparison ends when one of its documents is closed.
    const tabIdsKey = tabs.map(tab => tab.id).join('|');
    useEffect(() => {
        const open = new Set(tabIdsKey.split('|'));
        const gone = (side: CompareSide) => side.kind === 'tab' && !open.has(side.tabId);
        setViews(current => {
            const kept = current.filter(view => view.kind !== 'compare' || (!gone(view.left) && !gone(view.right)));
            return kept.length === current.length ? current : kept;
        });
    }, [tabIdsKey]);

    const resolveSide = (side: CompareSide, other: CompareSide): ResolvedSide | null => {
        if (side.kind === 'snapshot') {
            const otherTab = other.kind === 'tab' ? tabs.find(tab => tab.id === other.tabId) : undefined;
            return { kind: 'snapshot', label: side.label, text: side.text, language: otherTab?.language ?? 'plaintext' };
        }
        const tab = tabs.find(t => t.id === side.tabId);
        if (!tab) return null;
        return { kind: 'tab', tabId: tab.id, title: tab.title, content: tab.content, language: tab.language, readOnly: tab.isReadOnly, isDirty: tab.isDirty };
    };

    const viewTabs: ViewTab[] = views.map(view => ({
        id: view.id,
        kind: view.kind,
        title: viewTitle(view, tabs),
        tooltip: view.kind === 'log' ? `${view.path} (Large File / Log viewer)`
            : view.kind === 'scratchpad' ? 'Scratchpad: saved automatically, kept between launches'
            : `Compare: ${viewTitle(view, tabs)}`,
    }));

    const openScratchpad = () => {
        const existing = viewsRef.current.find(view => view.kind === 'scratchpad');
        if (existing) {
            showView(existing.id);
            return;
        }
        const id = newViewId();
        setViews(current => [...current, { id, kind: 'scratchpad', title: 'Scratchpad' }]);
        showView(id);
    };

    // ─── Text and Data Tools, marks ─────────────────────────────────────────

    const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);

    const openInNewTab = (content: string, language: string) => {
        const id = createNewTab();
        updateTabContentAndAutosave(id, content);
        changeLanguage(id, language);
    };

    const runTextTool = async (id: TextToolId, input?: { delimiter?: string; trimPieces?: boolean }) => {
        const { runTextTool: run } = await import('./utils/textToolRunner');
        await run(id, {
            editor: getActiveEditor(),
            openInNewTab,
            copyToClipboard: text => writeClipboardText(text),
            notify: (kind, message) => {
                if (kind === 'success') errorService.showSuccess(message);
                else if (kind === 'warning') errorService.showWarning(message);
                else errorService.showError(message);
            },
            input,
        });
    };

    const startTextTool = (id: TextToolId) => {
        if (id !== 'split') {
            void runTextTool(id);
            return;
        }
        setPromptRequest({
            title: 'Split Lines',
            label: 'Split each line at',
            placeholder: 'e.g. ,  or  ;  or  |',
            initial: ',',
            options: [{ key: 'trim', label: 'Trim spaces around each piece' }],
            submitLabel: 'Split',
            onSubmit: (delimiter, options) => {
                if (!delimiter) return 'Enter a delimiter to split on.';
                void runTextTool('split', { delimiter, trimPieces: options.trim });
            },
        });
    };

    // Re-render when marks change, so the palette lists the current ones.
    const [, setMarksVersion] = useState(0);
    useEffect(() => onMarksChanged(() => setMarksVersion(v => v + 1)), []);
    useEffect(() => onMarkProblem(message => errorService.showWarning(message)), []);

    const focusedModel = () => getActiveEditor()?.getModel() ?? null;

    /** Marks after making sure a regular expression is fast on this
     *  document: a mark re-runs as the text changes. */
    const markQuery = async (query: MarkQuery): Promise<string | void> => {
        const model = focusedModel();
        if (!model) return 'Open a document first.';
        // Monaco compiles patterns in Unicode mode, which is stricter (\- or
        // \_ are errors there); markProblem checks them the same way.
        const problem = markProblem(query);
        if (problem) return problem;
        if (query.regex) {
            if (await checkRegexSpeed(query.text, query.caseSensitive ? 'gmu' : 'gimu', model.getValue()) === 'slow') {
                return 'That regular expression takes too long on this document. Try a simpler pattern.';
            }
        }
        if (model.isDisposed()) return;
        const mark = await addMark(model, query);
        if (mark.count === 0) errorService.showWarning(`"${query.text}" doesn't occur in this document yet; it will be marked when it does.`);
    };

    const markSelection = () => {
        const ed = getActiveEditor();
        const model = ed?.getModel();
        if (!ed || !model) { errorService.showWarning('Open a document first.'); return; }
        const selection = ed.getSelection();
        // Line breaks as \n: Monaco searches across lines with \n, also in a
        // CRLF document.
        let text = selection && !selection.isEmpty() ? model.getValueInRange(selection, monaco.editor.EndOfLinePreference.LF) : '';
        if (!text && selection) text = model.getWordAtPosition(selection.getPosition())?.word ?? '';
        if (!text.trim()) { errorService.showWarning('Select the text to mark (or put the cursor on a word).'); return; }
        void markQuery({ text, regex: false, caseSensitive: true, wholeWord: false });
    };

    const markFindMatches = () => {
        const query = lastFindQuery();
        if (!query) { errorService.showWarning('Search for something with Find first.'); return; }
        void markQuery(query).then(problem => { if (problem) errorService.showWarning(problem); });
    };

    const promptMark = (regex: boolean) => setPromptRequest({
        title: regex ? 'Mark Regular Expression' : 'Mark Text',
        label: regex ? 'Mark every match of' : 'Mark every occurrence of',
        placeholder: regex ? 'e.g. customer_id=\\d+' : 'e.g. timeout',
        options: [
            { key: 'caseSensitive', label: 'Match case' },
            ...(regex ? [] : [{ key: 'wholeWord', label: 'Whole word' }]),
        ],
        submitLabel: 'Mark',
        onSubmit: (text, options) => {
            if (!text) return regex ? 'Enter a regular expression.' : 'Enter the text to mark.';
            return markQuery({ text, regex, caseSensitive: !!options.caseSensitive, wholeWord: !!options.wholeWord });
        },
    });

    const jumpToMark = (backwards: boolean) => {
        const ed = getActiveEditor();
        const model = ed?.getModel();
        const selection = ed?.getSelection();
        if (!ed || !model || !selection) return;
        // From the start of the current (marked) selection going back, its
        // end going forward, so the same occurrence isn't found again.
        const range = nextMarked(model, backwards ? selection.getStartPosition() : selection.getEndPosition(), backwards);
        if (!range) { errorService.showWarning('Nothing is marked in this document.'); return; }
        ed.setSelection(range);
        ed.revealRangeInCenterIfOutsideViewport(range);
        ed.focus();
    };

    const clearAllMarks = () => {
        const model = focusedModel();
        if (model) clearMarks(model);
    };

    /** Find, Go to Line and Save go to the view on screen, if there is one. */
    const runViewCommand = (name: keyof ViewCommands) => { viewCommandsRef.current?.[name]?.(); };
    const routeFind = () => { if (shownView) runViewCommand('find'); else handleFind(); };
    const routeReplace = () => { if (shownView) runViewCommand('find'); else handleReplace(); };
    const openGoToLine = () => { if (shownView) runViewCommand('goToLine'); else setGoToLineModalOpen(true); };
    const routeSave = () => {
        if (shownView) runViewCommand('save');
        else if (focusedTabId) void handleSave(focusedTabId);
    };
    const routeClose = () => {
        if (shownView) closeView(shownView.id);
        else if (focusedTabId) handleCloseTab(focusedTabId);
    };
    /** Choosing a document tab (tab bar, Cmd+1…9, cycling) leaves any view. */
    const selectTab = (tabId: string) => {
        setActiveView(null);
        setActiveTabId(tabId);
    };

    // ─── Keep handlers ref current (for stable event listeners) ────────────

    handlersRef.current = {
        createNewTab,
        openFile,
        openRequestedFile,
        openFileFromDialog,
        handleOpenFolder,
        activeTabId: focusedTabId,
        saveFile: handleSave,
        saveFileAs,
        handleCloseTab,
        handleFind: routeFind,
        handleReplace: routeReplace,
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
        shownViewId: shownView?.id ?? null,
        closeView,
        runViewCommand,
        openGoToLine,
        openLogView,
        compareFocusedWith,
        openCompareTabPicker: () => { setCommandPaletteQuery('Compare With Tab: '); setCommandPaletteOpen(true); },
        openScratchpad,
        openTextTools: () => { setCommandPaletteQuery(TEXT_TOOLS_CATEGORY); setCommandPaletteOpen(true); },
        markSelection,
        markFindMatches,
        jumpToMark,
        clearAllMarks,
        promptMark,
    };

    // ─── Keyboard shortcuts ─────────────────────────────────────────────────

    // The shortcut table is rebuilt every render (cheap) with fresh handler
    // closures and stashed in a ref. The capture-phase listener below is then
    // registered ONCE, so typing (which changes `tabs` on every keystroke) no
    // longer tears down and re-adds the global keydown listener each time.
    const shortcutsRef = useRef<ShortcutHandler[]>([]);
    {
        // The user's binding for a command, or its default from the shared
        // registry (the same list the shortcut editor and the macOS menu use).
        const kb = (id: string) => bindingFor(id, settings.keybindings);

        shortcutsRef.current = [
            { ...kb('new'), action: createNewTab },
            { ...kb('open'), action: openFileFromDialog },
            // stopPropagation: Monaco reads Ctrl+K as the start of a chord.
            { ...kb('openFolder'), action: handleOpenFolder, stopPropagation: true },
            { ...kb('save'), action: routeSave },
            { ...kb('saveAs'), action: () => focusedTabId && saveFileAs(focusedTabId) },
            { ...kb('close'), action: routeClose },
            { ...kb('find'), action: routeFind },
            { key: 'f', ctrlOrCmd: true, shift: true, action: () => setShowFindInFiles(v => !v) },
            { ...kb('replace'), action: routeReplace },
            { ...kb('goToLine'), action: openGoToLine },
            { ...kb('commandPalette'), action: () => setCommandPaletteOpen(true) },
            // Plain Ctrl/Cmd+P also opens the palette. This intercepts the key before the
            // Windows WebView2 default, which would otherwise open the OS print dialog
            // (the app has no print feature).
            { key: 'p', ctrlOrCmd: true, shift: false, action: () => setCommandPaletteOpen(true) },
            { key: '\\', ctrlOrCmd: true, action: handleToggleSplitView },
            { key: '=', ctrlOrCmd: true, action: () => updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, settings.fontSize + FONT_SIZE_STEP) }) },
            // Ctrl+Shift+= and the numeric keypad report "+".
            { key: '+', ctrlOrCmd: true, action: () => updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, settings.fontSize + FONT_SIZE_STEP) }) },
            { key: '-', ctrlOrCmd: true, action: () => updateSettings({ fontSize: Math.max(MIN_FONT_SIZE, settings.fontSize - FONT_SIZE_STEP) }) },
            { key: 'v', ctrlOrCmd: true, shift: true, action: () => focusedTabId && togglePreview(focusedTabId) },
            { key: ',', ctrlOrCmd: true, action: () => setSettingsModalOpen(true) },
            { ...kb('wordWrap'), action: () => updateSettings({ wordWrap: !settings.wordWrap }) },
            { ...kb('scratchpad'), action: openScratchpad },
            { ...kb('markSelection'), action: markSelection, stopPropagation: true },
            { ...kb('nextMark'), action: () => jumpToMark(false), stopPropagation: true },
            { ...kb('previousMark'), action: () => jumpToMark(true), stopPropagation: true },
            // F11 is the Windows/Linux convention; macOS uses its own system item.
            { key: 'F11', ctrlOrCmd: false, action: () => { void handleToggleFullScreen(); } },
            // Tab switching: Cmd/Ctrl+1-9
            ...([1,2,3,4,5,6,7,8,9].map(n => ({
                key: String(n),
                ctrlOrCmd: true,
                action: () => {
                    const idx = n - 1;
                    if (tabs[idx]) selectTab(tabs[idx].id);
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
                    selectTab(tabs[(idx + 1) % tabs.length].id);
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
                    selectTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
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
            if (document.querySelector('.modal-overlay, .cp-overlay')) {
                if (isBrowserNavigationKey(e)) e.preventDefault();
                return;
            }
            const handled = handleKeyDown(e, shortcutsRef.current);
            // Never let the webview reload or navigate the app (F5, Ctrl+R…):
            // that would discard every open document's unsaved state.
            if (!handled && isBrowserNavigationKey(e)) e.preventDefault();
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, []);

    // A folder passed at launch (zitext ., Finder) opens like one dropped later.
    useEffect(() => {
        if (!startupFolder) return;
        clearStartupFolder();
        setOpenedFolder(startupFolder);
        void updateSettings({ openedFolder: startupFolder, sidebarCollapsed: false })
            .catch(error => console.error('Failed to open startup folder:', error));
    }, [startupFolder, clearStartupFolder, setOpenedFolder, updateSettings]);

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

            // Files and folders from outside the app first: until these exist,
            // startup waits instead of collecting (see utils/openRequests).
            await l('open-file', async (event: unknown) => {
                const path = (event as { payload: string }).payload;
                try {
                    await handlersRef.current?.openRequestedFile(path);
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
            // Not from a run that was already cleaned up (StrictMode runs effects
            // twice in development): its listeners are gone.
            if (active) markOpenListenersReady();

            await l('menu-new', () => handlersRef.current?.createNewTab());
            await l('menu-open', () => handlersRef.current?.openFileFromDialog());
            await l('menu-open_folder', () => handlersRef.current?.handleOpenFolder());
            await l('menu-save', () => {
                const h = handlersRef.current;
                if (h?.shownViewId) h.runViewCommand('save');
                else if (h?.activeTabId) h.saveFile(h.activeTabId);
            });
            await l('menu-save_as', () => { const id = handlersRef.current?.activeTabId; if (id) handlersRef.current?.saveFileAs(id); });
            await l('menu-close', () => {
                const h = handlersRef.current;
                if (h?.shownViewId) h.closeView(h.shownViewId);
                else if (h?.activeTabId) h.handleCloseTab(h.activeTabId);
            });
            await l('menu-find', () => handlersRef.current?.handleFind());
            await l('menu-replace', () => handlersRef.current?.handleReplace());
            await l('menu-find_in_files', () => setShowFindInFiles(v => !v));
            await l('menu-goto', () => handlersRef.current?.openGoToLine());
            await l('menu-open_large_file', () => { void handlersRef.current?.openLogView(); });
            await l('menu-compare_file', () => { void handlersRef.current?.compareFocusedWith('file'); });
            await l('menu-compare_clipboard', () => { void handlersRef.current?.compareFocusedWith('clipboard'); });
            await l('menu-compare_saved', () => { void handlersRef.current?.compareFocusedWith('saved'); });
            await l('menu-compare_tab', () => handlersRef.current?.openCompareTabPicker());
            await l('menu-scratchpad', () => handlersRef.current?.openScratchpad());
            await l('menu-text_tools', () => handlersRef.current?.openTextTools());
            await l('menu-mark_selection', () => handlersRef.current?.markSelection());
            await l('menu-mark_find', () => handlersRef.current?.markFindMatches());
            await l('menu-next_mark', () => handlersRef.current?.jumpToMark(false));
            await l('menu-previous_mark', () => handlersRef.current?.jumpToMark(true));
            await l('menu-clear_marks', () => handlersRef.current?.clearAllMarks());
            await l('menu-mark_text', () => handlersRef.current?.promptMark(false));
            await l('menu-mark_regex', () => handlersRef.current?.promptMark(true));
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

            for (const lang of LANGUAGES.map(language => language.id)) {
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

    // JSON/XML/YAML palette tools: read-only documents are never changed, the
    // editor's tab size is used, and the file's line endings / final newline
    // are kept.
    // JSON and YAML tools run in the background, so a large document doesn't
    // freeze the window; the result is dropped if the document
    // changed meanwhile.
    const runBackgroundDataTool = async (task: (text: string) => HeavyTask, errorTitle: string, success?: string) => {
        if (!focusedTab) return;
        const tabId = focusedTab.id;
        const result = await applyDataTransformAsync(
            focusedTab,
            text => runHeavyTaskOffThread(task(text)),
            () => getTabContent(tabId),
        );
        if (result.kind === 'readOnly') {
            errorService.showWarning('This document is read-only. Turn off read-only to change it.');
        } else if (result.kind === 'stale') {
            errorService.showWarning('The document changed while it was being processed, so the result was not applied. Try again.');
        } else if (result.kind === 'error') {
            errorService.showError(errorTitle, result.error);
        } else {
            if (result.kind === 'changed') updateTabContentAndAutosave(tabId, result.content);
            if (success) errorService.showSuccess(success);
        }
    };

    const runDataTool = (transform: (text: string) => string, errorTitle: string, success?: string) => {
        if (!focusedTab) return;
        const result = applyDataTransform(focusedTab, transform);
        if (result.kind === 'readOnly') {
            errorService.showWarning('This document is read-only. Turn off read-only to change it.');
        } else if (result.kind === 'error') {
            errorService.showError(errorTitle, result.error);
        } else {
            if (result.kind === 'changed') updateTabContentAndAutosave(focusedTab.id, result.content);
            if (success) errorService.showSuccess(success);
        }
    };

    const allCommands = [
        // File
        { id: 'new-file',        label: 'New File',           description: 'Create a new untitled file',      category: 'File',    action: createNewTab },
        { id: 'open-file',       label: 'Open File',          description: 'Open a file from disk',           category: 'File',    action: openFileFromDialog },
        { id: 'open-folder',     label: 'Open Folder',        description: 'Open a workspace folder',         category: 'File',    action: handleOpenFolder },
        { id: 'save',            label: 'Save',               description: 'Save current file',               category: 'File',    action: routeSave },
        { id: 'save-as',         label: 'Save As',            description: 'Save current file with new name', category: 'File',    action: () => focusedTabId && saveFileAs(focusedTabId) },
        { id: 'revert-file',     label: 'Revert File',        description: 'Go back to the last saved version', category: 'File', action: handleRevertFile },
        { id: 'close-tab',       label: 'Close Tab',          description: 'Close the current tab',           category: 'File',    action: routeClose },
        { id: 'open-large-file', label: 'Open Large File or Log…', description: 'View a file of any size, follow it as it grows, filter and export lines', category: 'File', action: () => { void openLogView(); } },
        { id: 'open-in-log-viewer', label: 'Open Current File in Log Viewer', description: 'Follow, filter and highlight the saved file', category: 'File', action: () => { if (focusedTab?.path) void openLogView(focusedTab.path); else errorService.showWarning('Save the document first; the log viewer reads files from disk.'); } },
        // Scratchpad, Text and Data Tools, marks
        { id: 'scratchpad',      label: 'Open Scratchpad',    description: 'A note that saves itself and is kept between launches', category: 'File', action: openScratchpad },
        ...TEXT_TOOLS.map(tool => ({
            id: `tool-${tool.id}`,
            label: tool.label,
            description: tool.description,
            category: TEXT_TOOLS_CATEGORY,
            action: () => startTextTool(tool.id),
        })),
        { id: 'mark-selection',  label: 'Mark Selection',     description: 'Keep every occurrence highlighted in its own colour', category: 'Marks', action: markSelection },
        { id: 'mark-find',       label: 'Mark Find Matches',  description: 'Mark what Find is searching for', category: 'Marks', action: markFindMatches },
        { id: 'mark-text',       label: 'Mark Text…',         description: 'Mark every occurrence of text you type', category: 'Marks', action: () => promptMark(false) },
        { id: 'mark-regex',      label: 'Mark Regular Expression…', description: 'Mark every match of a pattern', category: 'Marks', action: () => promptMark(true) },
        { id: 'mark-next',       label: 'Next Marked Occurrence', description: 'Go to the next marked text', category: 'Marks', action: () => jumpToMark(false) },
        { id: 'mark-previous',   label: 'Previous Marked Occurrence', description: 'Go to the previous marked text', category: 'Marks', action: () => jumpToMark(true) },
        { id: 'mark-clear-all',  label: 'Clear All Marks',    description: 'In this document', category: 'Marks', action: clearAllMarks },
        ...marksOf(focusedModel()).map(mark => ({
            id: `mark-clear-${mark.id}`,
            label: `Clear Mark: ${mark.regex ? `/${mark.text}/` : mark.text}`,
            description: mark.off ? 'Turned off: too slow on this document'
                : mark.capped ? `${mark.count.toLocaleString()}+ occurrences (the first ${mark.count.toLocaleString()} are highlighted; F4 reaches all)`
                : `${mark.count.toLocaleString()} ${mark.count === 1 ? 'occurrence' : 'occurrences'}`,
            category: 'Marks',
            action: () => { const model = focusedModel(); if (model) removeMark(model, mark.id); },
        })),
        // Compare
        { id: 'compare-file',    label: 'Compare With File…', description: 'Show the differences from another file', category: 'Compare', action: () => { void compareFocusedWith('file'); } },
        { id: 'compare-clipboard', label: 'Compare With Clipboard', description: 'Show the differences from the clipboard text', category: 'Compare', action: () => { void compareFocusedWith('clipboard'); } },
        { id: 'compare-saved',   label: 'Compare With Saved Version', description: 'Show unsaved changes against the file on disk', category: 'Compare', action: () => { void compareFocusedWith('saved'); } },
        ...tabs.filter(tab => tab.id !== focusedTabId).map(tab => ({
            id: `compare-tab-${tab.id}`,
            label: `Compare With Tab: ${tab.title}`,
            description: tab.path ?? 'Unsaved document',
            category: 'Compare',
            action: () => { void compareFocusedWith({ tabId: tab.id }); },
        })),
        // Edit
        { id: 'find',            label: 'Find',               description: 'Find in current file',            category: 'Edit',    action: routeFind },
        { id: 'replace',         label: 'Find & Replace',     description: 'Find and replace in current file',category: 'Edit',    action: routeReplace },
        { id: 'find-in-files',   label: 'Find in Files',      description: 'Search across all files',         category: 'Edit',    action: () => setShowFindInFiles(v => !v) },
        { id: 'go-to-line',      label: 'Go to Line',         description: 'Jump to a specific line number',  category: 'Edit',    action: openGoToLine },
        // Language
        ...LANGUAGES.map(language => ({
            id: `language-${language.id}`,
            label: `Change Language Mode: ${language.label}`,
            description: `Highlight this document as ${language.label}`,
            category: 'Language',
            action: () => handleChangeLanguage(language.id),
        })),
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
        // JSON with comments (tsconfig.json…) uses the editor's formatter, which keeps comments.
        { id: 'json-format',     label: 'Format JSON',        description: 'Pretty-print JSON',               category: 'JSON',    action: () => isJsoncPath(focusedTab?.path ?? null) ? handleFormatDocument() : void runBackgroundDataTool(text => ({ kind: 'formatJson', text, indent: settings.tabSize }), 'Invalid JSON', 'JSON formatted') },
        { id: 'json-minify',     label: 'Minify JSON',        description: 'Remove whitespace from JSON',     category: 'JSON',    action: () => void runBackgroundDataTool(text => ({ kind: 'minifyJson', text }), 'Invalid JSON') },
        { id: 'json-validate',   label: 'Validate JSON',      description: 'Check if JSON is valid',          category: 'JSON',    action: () => { if (!focusedTab) return; const r = validateJson(focusedTab.content); if (r.valid) { errorService.showSuccess('Valid JSON'); } else { errorService.showError(r.line ? `Invalid JSON at line ${r.line}: ${r.error}` : `Invalid JSON: ${r.error}`); } } },
        { id: 'json-sort-keys',  label: 'Sort JSON Keys',     description: 'Sort object keys alphabetically', category: 'JSON',    action: () => void runBackgroundDataTool(text => ({ kind: 'sortJsonKeys', text, indent: settings.tabSize }), 'Invalid JSON') },
        { id: 'xml-format',      label: 'Format XML',         description: 'Format XML with indentation',     category: 'XML',     action: () => runDataTool(text => formatXml(text, settings.tabSize), 'Unable to format XML') },
        { id: 'xml-validate',    label: 'Validate XML',       description: 'Check if XML is valid',           category: 'XML',     action: () => { if (!focusedTab) return; const r = validateXml(focusedTab.content); if (r.valid) { errorService.showSuccess('Valid XML'); } else { errorService.showError(`Invalid XML: ${r.error}`); } } },
        { id: 'yaml-format',     label: 'Format YAML',        description: 'Format YAML with indentation',    category: 'YAML',    action: () => void runBackgroundDataTool(text => ({ kind: 'formatYaml', text, indent: settings.tabSize }), 'Unable to format YAML') },
    ];

    // Counted once per content change, without splitting the document into an
    // array: this used to run on every render, including each cursor move.
    const focusedContent = focusedTab?.content;
    const maxLine = useMemo(() => (focusedContent === undefined ? 1 : countLines(focusedContent)), [focusedContent]);

    if (isLoading) {
        return <div className="loading"><div>Loading...</div></div>;
    }


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
                <Suspense fallback={null}>
                    <UpdateAvailableModal
                        update={availableUpdate}
                        onLater={dismissUpdate}
                        onSkip={skipUpdate}
                    />
                </Suspense>
            )}
            {!isMac && (
                <MenuBar
                    onNew={createNewTab}
                    onOpen={openFileFromDialog}
                    onOpenFolder={handleOpenFolder}
                    onSave={routeSave}
                    onSaveAs={() => focusedTabId && saveFileAs(focusedTabId)}
                    onClose={routeClose}
                    onOpenLargeFile={() => { void openLogView(); }}
                    onCompareWithFile={() => { void compareFocusedWith('file'); }}
                    onCompareWithClipboard={() => { void compareFocusedWith('clipboard'); }}
                    onCompareWithSaved={() => { void compareFocusedWith('saved'); }}
                    onCompareWithTab={() => handlersRef.current?.openCompareTabPicker()}
                    onOpenScratchpad={openScratchpad}
                    onTextTool={startTextTool}
                    onMarkSelection={markSelection}
                    onMarkFind={markFindMatches}
                    onMarkText={() => promptMark(false)}
                    onMarkRegex={() => promptMark(true)}
                    onNextMark={() => jumpToMark(false)}
                    onPreviousMark={() => jumpToMark(true)}
                    onClearMarks={clearAllMarks}
                    onRevertFile={handleRevertFile}
                    onUndo={handleUndo}
                    onRedo={handleRedo}
                    onCut={handleCut}
                    onCopy={handleCopy}
                    onPaste={handlePaste}
                    onSelectAll={handleSelectAll}
                    onToggleLineComment={handleToggleLineComment}
                    onFormatDocument={handleFormatDocument}
                    onFind={routeFind}
                    onFindInFiles={() => setShowFindInFiles(v => !v)}
                    onReplace={routeReplace}
                    onGoToLine={openGoToLine}
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
                    shownViewKind={shownView?.kind ?? null}
                    canPreview={!!focusedTab && canPreviewMarkdown(focusedTab.language)}
                    isReadOnly={focusedTab?.isReadOnly || false}
                    isPreview={!!focusedTab && showsPreview(focusedTab)}
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
                activeTabId={shownView ? null : activeTabId}
                views={viewTabs}
                activeViewId={shownView?.id ?? null}
                onViewClick={(id) => showView(id)}
                onViewClose={closeView}
                onTabClick={(tabId) => {
                    setActiveView(null);
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
                isPreview={!!focusedTab && showsPreview(focusedTab)}
                canPreview={!!focusedTab && canPreviewMarkdown(focusedTab.language)}
            />

            <div className="app-main">
                {/* Sidebar: Find in Files always shows when toggled on (even if the
                    Explorer sidebar is collapsed); otherwise the Explorer respects collapse. */}
                {/* Both panels stay mounted while hidden, so the explorer's
                    expanded folders and the search results survive toggling. */}
                {(findInFilesUsed || showFindInFiles) && (
                    <Suspense fallback={null}>
                    <FindInFiles
                        visible={showFindInFiles}
                        folderPath={openedFolder}
                        width={sidebarWidth}
                        onOpenFile={handleOpenFileAtLine}
                        onOpenFolder={async () => {
                            const path = await openFolder();
                            if (path) await updateSettings({ openedFolder: path, sidebarCollapsed: false });
                        }}
                        onClose={() => setShowFindInFiles(false)}
                    />
                    </Suspense>
                )}
                {
                    <FileExplorer
                        folderPath={openedFolder}
                        onFolderOpen={handleExplorerFolderOpen}
                        onFileSelect={handleFileSelect}
                        activePath={focusedTab?.path ?? null}
                        dirtyPaths={dirtyPaths}
                        onClose={handleToggleSidebar}
                        onCloseFolder={handleCloseFolder}
                        collapsed={sidebarCollapsed || showFindInFiles}
                        width={sidebarWidth}
                        onWidthChange={handleSidebarWidthChange}
                    />
                }

                <div className="app-content">
                    {focusedTab?.path && (
                        <Breadcrumb
                            path={focusedTab.path}
                            lineCount={maxLine}
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
                                    return saveFile(focusedTab.id, undefined, { manual: true });
                                }
                                return reloadFileFromDisk(focusedTab.id).catch(error => {
                                    errorService.showError('Failed to reload file', error as Error);
                                });
                            }}
                            onIgnore={() => ignoreExternalChange(focusedTab.id)}
                        />
                    )}

                    {/* Views stay mounted while another tab is shown, so a log keeps
                        its position, filters and bookmarks, and a comparison its
                        options. */}
                    {views.length > 0 && (
                        <Suspense fallback={null}>
                            {views.map(view => {
                                const visible = view.id === shownView?.id;
                                if (view.kind === 'log') {
                                    return (
                                        <div key={view.id} id={visible ? 'editor-workspace' : undefined} className="workspace-view" style={visible ? undefined : { display: 'none' }}>
                                            <LogViewer
                                                path={view.path}
                                                visible={visible}
                                                fontFamily={settings.fontFamily}
                                                fontSize={settings.fontSize}
                                                onRegisterCommands={registerViewCommands}
                                            />
                                        </div>
                                    );
                                }
                                if (view.kind === 'scratchpad') {
                                    return (
                                        <div key={view.id} id={visible ? 'editor-workspace' : undefined} className="workspace-view" style={visible ? undefined : { display: 'none' }}>
                                            <PaneErrorBoundary resetKey={view.id}>
                                                <ScratchpadView
                                                    visible={visible}
                                                    editorTheme={effectiveEditorTheme}
                                                    fontFamily={settings.fontFamily}
                                                    fontSize={settings.fontSize}
                                                    wordWrap={settings.wordWrap}
                                                    onRegisterCommands={registerViewCommands}
                                                />
                                            </PaneErrorBoundary>
                                        </div>
                                    );
                                }
                                const left = resolveSide(view.left, view.right);
                                const right = resolveSide(view.right, view.left);
                                if (!left || !right) return null;
                                return (
                                    <div key={view.id} id={visible ? 'editor-workspace' : undefined} className="workspace-view" style={visible ? undefined : { display: 'none' }}>
                                        <PaneErrorBoundary resetKey={view.id}>
                                            <CompareView
                                                viewId={view.id}
                                                left={left}
                                                right={right}
                                                visible={visible}
                                                editorTheme={effectiveEditorTheme}
                                                fontFamily={settings.fontFamily}
                                                fontSize={settings.fontSize}
                                                onTabEdited={updateTabContentAndAutosave}
                                                onSaveTab={(tabId) => { void handleSave(tabId); }}
                                                onSwap={() => swapCompareSides(view.id)}
                                                onRegisterCommands={registerViewCommands}
                                            />
                                        </PaneErrorBoundary>
                                    </div>
                                );
                            })}
                        </Suspense>
                    )}

                    {shownView ? null : tabs.length === 0 ? (
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
                                previewActive={!!focusedTab && showsPreview(focusedTab)}
                            />
                            {/* A crash inside an editor pane stays in the pane: tab state
                                lives here in App, so the documents survive and the pane can
                                be reopened (previously the whole app was replaced). */}
                            <PaneErrorBoundary resetKey={`${activeTab.id}|${rightPaneTabId ?? ''}|${showsPreview(activeTab) ? 'preview' : 'editor'}`}>
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
                                    onOpenFile={(path) => { void openFile(path); }}
                                    leftPreviewRef={previewBodyRef}
                                    rightPreviewRef={rightPreviewBodyRef}
                                    activePane={activePane}
                                />
                            ) : showsPreview(activeTab) ? (
                                <MarkdownPreview
                                    content={activeTab.content}
                                    bodyRef={previewBodyRef}
                                    documentPath={activeTab.path}
                                    onOpenFile={(path) => { void openFile(path); }}
                                />
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
                                    allowJsonComments={isJsoncPath(activeTab.path)}
                                    revealRequest={activeTab.revealRequest}
                                    onChange={(content) => updateTabContentAndAutosave(activeTab.id, content)}
                                    onCursorChange={(line, col) => updateCursorPosition(activeTab.id, line, col)}
                                    onScrollChange={(top, left) => updateScrollPosition(activeTab.id, top, left)}
                                    onSelectionChange={setSelectionLength}
                                    onEditorReady={setLeftEditorInstance}
                                    onFocus={() => { activePaneRef.current = 'left'; setActivePane('left'); }}
                                />
                            )}
                            </PaneErrorBoundary>
                        </div>
                    ) : null}

                </div>
            </div>

            {/* Outside .app-main so the bar spans the whole window, running under
                the sidebar as well as the editor — as in the design. */}
            {focusedTab && (
                <StatusBar
                    tabId={focusedTab.id}
                    line={focusedTab.cursorLine}
                    column={focusedTab.cursorColumn}
                    language={focusedTab.language}
                    encoding={focusedTab.encoding}
                    eol={focusedTab.eol}
                    content={focusedTab.content}
                    selectionLength={selectionLength}
                    fontSize={settings.fontSize}
                    showMinimap={settings.showMinimap}
                    onZoomIn={() => updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, settings.fontSize + FONT_SIZE_STEP) })}
                    onZoomOut={() => updateSettings({ fontSize: Math.max(MIN_FONT_SIZE, settings.fontSize - FONT_SIZE_STEP) })}
                    onToggleMinimap={() => updateSettings({ showMinimap: !settings.showMinimap })}
                    onChangeLanguage={() => { setCommandPaletteQuery('Change Language Mode: '); setCommandPaletteOpen(true); }}
                />
            )}

            {goToLineModalOpen && (
                <Suspense fallback={null}>
                    <GoToLineModal isOpen onClose={() => setGoToLineModalOpen(false)} onGoToLine={handleGoToLine} maxLine={maxLine} />
                </Suspense>
            )}
            {settingsModalOpen && (
                <Suspense fallback={null}>
                    <SettingsModal isOpen onClose={() => setSettingsModalOpen(false)} settings={settings} onSave={updateSettings} />
                </Suspense>
            )}
            {promptRequest && (
                <Suspense fallback={null}>
                    <InputPrompt request={promptRequest} onClose={() => setPromptRequest(null)} />
                </Suspense>
            )}
            <CommandPalette
                isOpen={commandPaletteOpen}
                initialQuery={commandPaletteQuery}
                onClose={() => { setCommandPaletteOpen(false); setCommandPaletteQuery(''); }}
                commands={allCommands}
            />
            {keybindingEditorOpen && (
                <Suspense fallback={null}>
                    <KeybindingEditor isOpen onClose={() => setKeybindingEditorOpen(false)} keybindings={settings.keybindings} onSave={(keybindings) => {
                        // The macOS menu shows (and answers to) the same keys.
                        void updateSettings({ keybindings }).then(() => rebuildNativeMenu());
                    }} />
                </Suspense>
            )}

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

            {showDiagnostics && (
                <Suspense fallback={null}>
                    <DiagnosticsPanel isOpen onClose={() => setShowDiagnostics(false)} tabCount={tabs.length} />
                </Suspense>
            )}

            <ToastContainer />
        </div>
    );
}

export default App;
