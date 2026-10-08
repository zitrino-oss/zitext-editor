import { useState, useCallback, useRef } from 'react';
import type { Tab } from '../types';
import { clearLiveCursor, setLiveCursor } from '../utils/liveCursor';
import { canPreviewMarkdown } from '../utils/languages';

/** How long cursor/scroll positions wait to settle before reaching tab state. */
const VIEW_COMMIT_DELAY_MS = 300;
const VIEW_KEYS = ['cursorLine', 'cursorColumn', 'scrollTop', 'scrollLeft'] as const;

export type TabSaveSnapshot = Pick<
    Tab,
    'content' | 'revision' | 'path' | 'title' | 'encoding' | 'diskVersion'
>;

type TabSaveMetadata = Pick<Tab, 'path' | 'title' | 'encoding' | 'diskVersion'>;

function saveMetadataFromTab(tab: Tab): TabSaveMetadata {
    return {
        path: tab.path,
        title: tab.title,
        encoding: tab.encoding,
        diskVersion: tab.diskVersion,
    };
}

export function isSavedRevisionCurrent(
    currentRevision: number,
    savedRevision: number,
): boolean {
    return currentRevision === savedRevision;
}

/**
 * useTabManager - Manages tab state and operations
 * 
 * Handles tab creation, closing, switching, and content updates.
 * Separated from useEditorState for better modularity.
 */
export function useTabManager() {
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
    const revisionRef = useRef(new Map<string, number>());
    const contentRef = useRef(new Map<string, string>());
    // Save-critical metadata lives beside content/revision so a queued save
    // never combines a synchronous buffer snapshot with render-lagged tab data.
    const saveMetadataRef = useRef(new Map<string, TabSaveMetadata>());

    // Cursor and scroll positions reach tab state only once they settle:
    // every move used to re-render the whole app, and
    // scrolling did so on every frame. The status bar reads the live cursor
    // from utils/liveCursor instead.
    const pendingView = useRef(new Map<string, Partial<Tab>>());
    const viewTimers = useRef(new Map<string, number>());

    const commitView = useCallback((tabId: string): void => {
        const timer = viewTimers.current.get(tabId);
        if (timer !== undefined) window.clearTimeout(timer);
        viewTimers.current.delete(tabId);
        const view = pendingView.current.get(tabId);
        pendingView.current.delete(tabId);
        if (!view || Object.keys(view).length === 0) return;
        setTabs(prev => prev.map(tab => (tab.id === tabId ? { ...tab, ...view } : tab)));
    }, []);

    const scheduleView = useCallback((tabId: string, view: Partial<Tab>): void => {
        pendingView.current.set(tabId, { ...pendingView.current.get(tabId), ...view });
        const timer = viewTimers.current.get(tabId);
        if (timer !== undefined) window.clearTimeout(timer);
        viewTimers.current.set(tabId, window.setTimeout(() => commitView(tabId), VIEW_COMMIT_DELAY_MS));
    }, [commitView]);

    /** An explicit position (Go to Line, a search result, restore) wins over
     *  a pending one from earlier cursor moves, which must not land later. */
    const dropPendingView = useCallback((tabId: string, updates: Partial<Tab>): void => {
        const view = pendingView.current.get(tabId);
        if (!view) return;
        for (const key of VIEW_KEYS) {
            if (key in updates) delete view[key];
        }
    }, []);

    // Switching tabs writes the positions first, so the tab being left keeps
    // where its cursor was.
    const setActiveTabId = useCallback((tabId: string | null): void => {
        for (const pendingTabId of [...pendingView.current.keys()]) commitView(pendingTabId);
        setActiveTabIdState(tabId);
    }, [commitView]);

    const nextRevision = useCallback((tabId: string): number => {
        const revision = (revisionRef.current.get(tabId) ?? 0) + 1;
        revisionRef.current.set(tabId, revision);
        return revision;
    }, []);

    /**
     * Create a new untitled tab
     */
    const createNewTab = useCallback((): string => {
        // Generate the ID before the state updater so we can return it
        // and call setActiveTabId without capturing `tabs` in the closure.
        const newTabId = `tab-${Date.now()}-${Math.random()}`;
        revisionRef.current.set(newTabId, 0);
        contentRef.current.set(newTabId, '');
        saveMetadataRef.current.set(newTabId, {
            path: null,
            title: 'Untitled',
            encoding: 'UTF-8',
            diskVersion: null,
        });

        setTabs(prev => {
            const untitledNumbers = prev
                .filter(tab => tab.path === null)
                .map(tab => {
                    const match = tab.title.match(/Untitled-(\d+)/);
                    return match ? parseInt(match[1]) : 0;
                });
            const nextNumber = untitledNumbers.length > 0
                ? Math.max(...untitledNumbers) + 1
                : 1;
            const newTab: Tab = {
                id: newTabId,
                path: null,
                title: `Untitled-${nextNumber}`,
                content: '',
                revision: 0,
                cursorLine: 1,
                cursorColumn: 1,
                isDirty: false,
                language: 'plaintext',
                isReadOnly: false,
                encoding: 'UTF-8',
                diskVersion: null,
                eol: 'LF',
                scrollTop: 0,
                scrollLeft: 0,
                isUntitled: true,
                externallyModified: false,
                externalChangeCount: 0,
            };
            // If an immediate restore update already supplied a title, retain
            // it. Otherwise replace the short-lived provisional metadata with
            // the same numbered title rendered by the tab state.
            const metadata = saveMetadataRef.current.get(newTabId);
            if (metadata?.title === 'Untitled') {
                saveMetadataRef.current.set(newTabId, saveMetadataFromTab(newTab));
            }
            return [...prev, newTab];
        });

        setActiveTabId(newTabId);
        return newTabId;
    }, [setActiveTabId]); // No dependency on `tabs` — uses functional updater form

    /**
     * Add a new tab with specific properties
     */
    const addTab = useCallback((tab: Tab): void => {
        revisionRef.current.set(tab.id, tab.revision);
        contentRef.current.set(tab.id, tab.content);
        saveMetadataRef.current.set(tab.id, saveMetadataFromTab(tab));
        setTabs(prev => [...prev, tab]);
        setActiveTabId(tab.id);
    }, [setActiveTabId]);

    /**
     * Close a tab by ID
     */
    const closeTab = useCallback((tabId: string) => {
        const timer = viewTimers.current.get(tabId);
        if (timer !== undefined) window.clearTimeout(timer);
        viewTimers.current.delete(tabId);
        pendingView.current.delete(tabId);
        clearLiveCursor(tabId);
        revisionRef.current.delete(tabId);
        contentRef.current.delete(tabId);
        saveMetadataRef.current.delete(tabId);
        setTabs(prevTabs => {
            const newTabs = prevTabs.filter(t => t.id !== tabId);

            // If we're closing the active tab, switch to another tab
            if (activeTabId === tabId) {
                if (newTabs.length > 0) {
                    const closedIndex = prevTabs.findIndex(t => t.id === tabId);
                    const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
                    setActiveTabIdState(newTabs[newActiveIndex].id);
                } else {
                    // No tabs left, set activeTabId to null to show welcome screen
                    setActiveTabIdState(null);
                }
            }

            return newTabs;
        });
    }, [activeTabId]);

    /**
     * Update tab content
     */
    const updateTabContent = useCallback((tabId: string, content: string): void => {
        const revision = nextRevision(tabId);
        contentRef.current.set(tabId, content);
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, content, revision, isDirty: true }
                : tab
        ));
    }, [nextRevision]);

    /**
     * Update cursor position
     */
    const updateCursorPosition = useCallback((tabId: string, line: number, column: number): void => {
        setLiveCursor(tabId, line, column);
        scheduleView(tabId, { cursorLine: line, cursorColumn: column });
    }, [scheduleView]);

    const updateScrollPosition = useCallback((
        tabId: string,
        scrollTop: number,
        scrollLeft: number,
    ): void => {
        scheduleView(tabId, { scrollTop, scrollLeft });
    }, [scheduleView]);

    const getTabRevision = useCallback((tabId: string): number => {
        return revisionRef.current.get(tabId) ?? 0;
    }, []);

    const getTabContent = useCallback((tabId: string): string | undefined => {
        return contentRef.current.get(tabId);
    }, []);

    /**
     * Synchronous save snapshot, or null once the tab has been closed.
     * Callers must treat null as "nothing to save": returning defaults here
     * (empty content, no path) once made a queued save of a closed tab open a
     * Save As dialog and write an empty file.
     */
    const getTabSaveSnapshot = useCallback((tabId: string): TabSaveSnapshot | null => {
        const metadata = saveMetadataRef.current.get(tabId);
        const content = contentRef.current.get(tabId);
        if (!metadata || content === undefined) return null;
        return {
            content,
            revision: revisionRef.current.get(tabId) ?? 0,
            path: metadata.path,
            title: metadata.title,
            encoding: metadata.encoding,
            diskVersion: metadata.diskVersion,
        };
    }, []);

    /**
     * Update tab properties
     */
    const updateTab = useCallback((tabId: string, updates: Partial<Tab>): void => {
        dropPendingView(tabId, updates);
        if (updates.cursorLine !== undefined && updates.cursorColumn !== undefined) {
            setLiveCursor(tabId, updates.cursorLine, updates.cursorColumn);
        }
        const hasContent = Object.prototype.hasOwnProperty.call(updates, 'content');
        const revision = hasContent ? nextRevision(tabId) : undefined;
        if (hasContent && updates.content !== undefined) {
            contentRef.current.set(tabId, updates.content);
        }
        const metadata = saveMetadataRef.current.get(tabId);
        if (metadata) {
            saveMetadataRef.current.set(tabId, {
                path: updates.path === undefined ? metadata.path : updates.path,
                title: updates.title ?? metadata.title,
                encoding: updates.encoding ?? metadata.encoding,
                diskVersion: updates.diskVersion === undefined
                    ? metadata.diskVersion
                    : updates.diskVersion,
            });
        }
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, ...updates, ...(revision === undefined ? {} : { revision }) }
                : tab
        ));
    }, [nextRevision, dropPendingView]);

    /**
     * Applies post-save metadata and clears dirty only when no content update
     * occurred after the saved snapshot was captured.
     */
    const markTabSaved = useCallback((
        tabId: string,
        savedRevision: number,
        updates: Partial<Tab>,
    ): boolean => {
        const isCurrent = isSavedRevisionCurrent(
            revisionRef.current.get(tabId) ?? 0,
            savedRevision,
        );
        const metadata = saveMetadataRef.current.get(tabId);
        if (metadata) {
            saveMetadataRef.current.set(tabId, {
                path: updates.path === undefined ? metadata.path : updates.path,
                title: updates.title ?? metadata.title,
                encoding: updates.encoding ?? metadata.encoding,
                diskVersion: updates.diskVersion === undefined
                    ? metadata.diskVersion
                    : updates.diskVersion,
            });
        }
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, ...updates, isDirty: isCurrent ? false : tab.isDirty }
                : tab
        ));
        return isCurrent;
    }, []);

    /**
     * Toggle read-only mode
     */
    const toggleReadOnly = useCallback((tabId: string): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, isReadOnly: !tab.isReadOnly }
                : tab
        ));
    }, []);

    /**
     * Change language mode
     */
    const changeLanguage = useCallback((tabId: string, language: string): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, language, languageLocked: true }
                : tab
        ));
    }, []);

    /**
     * Mark tab as externally modified
     */
    const markExternallyModified = useCallback((tabId: string): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, externallyModified: true, externalChangeCount: tab.externalChangeCount + 1 }
                : tab
        ));
    }, []);

    /**
     * Clear external modification flag
     */
    const clearExternalModification = useCallback((tabId: string): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, externallyModified: false }
                : tab
        ));
    }, []);

    /**
     * Reorder tabs
     */
    const reorderTabs = useCallback((startIndex: number, endIndex: number): void => {
        setTabs(prev => {
            const result = Array.from(prev);
            const [removed] = result.splice(startIndex, 1);
            result.splice(endIndex, 0, removed);
            return result;
        });
    }, []);

    /**
     * Get active tab
     */
    const activeTab = tabs.find(t => t.id === activeTabId) || null;

    /**
     * The tab showing `path`, if any (other than `exceptTabId`). Reads the
     * synchronous metadata, not render state: two opens of the same file in
     * quick succession (startup events, drag and drop, session restore) must
     * see each other's tab before React re-renders.
     */
    /** Ids of the open tabs, read synchronously (not from render state). */
    const getTabIds = useCallback((): string[] => [...saveMetadataRef.current.keys()], []);

    const findTabIdByPath = useCallback((path: string, exceptTabId?: string): string | undefined => {
        for (const [tabId, metadata] of saveMetadataRef.current) {
            if (metadata.path === path && tabId !== exceptTabId) return tabId;
        }
        return undefined;
    }, []);

    /**
     * Toggle preview mode for a tab
     */
    const togglePreview = useCallback((tabId: string): void => {
        // Only Markdown has a preview; turning one off always works.
        setTabs(prev => prev.map(tab =>
            tab.id === tabId && (tab.isPreview || canPreviewMarkdown(tab.language))
                ? { ...tab, isPreview: !tab.isPreview }
                : tab
        ));
    }, []);

    /**
     * Toggle pinned state for a tab
     */
    const togglePinTab = useCallback((tabId: string): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, isPinned: !tab.isPinned }
                : tab
        ));
    }, []);

    return {
        tabs,
        activeTab,
        activeTabId,
        setActiveTabId,
        createNewTab,
        addTab,
        closeTab,
        updateTabContent,
        updateCursorPosition,
        updateScrollPosition,
        getTabRevision,
        getTabContent,
        getTabSaveSnapshot,
        updateTab,
        markTabSaved,
        toggleReadOnly,
        changeLanguage,
        togglePreview,
        togglePinTab,
        markExternallyModified,
        clearExternalModification,
        reorderTabs,
        findTabIdByPath,
        getTabIds,
    };
}
