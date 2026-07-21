import { useState, useCallback, useRef } from 'react';
import type { Tab } from '../types';

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
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const revisionRef = useRef(new Map<string, number>());
    const contentRef = useRef(new Map<string, string>());
    // Save-critical metadata lives beside content/revision so a queued save
    // never combines a synchronous buffer snapshot with render-lagged tab data.
    const saveMetadataRef = useRef(new Map<string, TabSaveMetadata>());

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
    }, []); // No dependency on `tabs` — uses functional updater form

    /**
     * Add a new tab with specific properties
     */
    const addTab = useCallback((tab: Tab): void => {
        revisionRef.current.set(tab.id, tab.revision);
        contentRef.current.set(tab.id, tab.content);
        saveMetadataRef.current.set(tab.id, saveMetadataFromTab(tab));
        setTabs(prev => [...prev, tab]);
        setActiveTabId(tab.id);
    }, []);

    /**
     * Close a tab by ID
     */
    const closeTab = useCallback((tabId: string) => {
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
                    setActiveTabId(newTabs[newActiveIndex].id);
                } else {
                    // No tabs left, set activeTabId to null to show welcome screen
                    setActiveTabId(null);
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
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, cursorLine: line, cursorColumn: column }
                : tab
        ));
    }, []);

    const updateScrollPosition = useCallback((
        tabId: string,
        scrollTop: number,
        scrollLeft: number,
    ): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, scrollTop, scrollLeft }
                : tab
        ));
    }, []);

    const getTabRevision = useCallback((tabId: string): number => {
        return revisionRef.current.get(tabId) ?? 0;
    }, []);

    const getTabContent = useCallback((tabId: string): string | undefined => {
        return contentRef.current.get(tabId);
    }, []);

    const getTabSaveSnapshot = useCallback((tabId: string): TabSaveSnapshot => {
        const metadata = saveMetadataRef.current.get(tabId);
        return {
            content: contentRef.current.get(tabId) ?? '',
            revision: revisionRef.current.get(tabId) ?? 0,
            path: metadata?.path ?? null,
            title: metadata?.title ?? 'Untitled',
            encoding: metadata?.encoding ?? 'UTF-8',
            diskVersion: metadata?.diskVersion ?? null,
        };
    }, []);

    /**
     * Update tab properties
     */
    const updateTab = useCallback((tabId: string, updates: Partial<Tab>): void => {
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
    }, [nextRevision]);

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
                ? { ...tab, language }
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
     * Find tab by path
     */
    const findTabByPath = useCallback((path: string): Tab | undefined => {
        return tabs.find(tab => tab.path === path);
    }, [tabs]);

    /**
     * Toggle preview mode for a tab
     */
    const togglePreview = useCallback((tabId: string): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
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
        findTabByPath,
    };
}
