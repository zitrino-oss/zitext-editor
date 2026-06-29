import { useState, useCallback } from 'react';
import type { Tab } from '../types';

/**
 * useTabManager - Manages tab state and operations
 * 
 * Handles tab creation, closing, switching, and content updates.
 * Separated from useEditorState for better modularity.
 */
export function useTabManager() {
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);

    /**
     * Create a new untitled tab
     */
    const createNewTab = useCallback((): string => {
        // Generate the ID before the state updater so we can return it
        // and call setActiveTabId without capturing `tabs` in the closure.
        const newTabId = `tab-${Date.now()}-${Math.random()}`;

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
                cursorLine: 1,
                cursorColumn: 1,
                isDirty: false,
                language: 'plaintext',
                isReadOnly: false,
                encoding: 'UTF-8',
                eol: 'LF',
                scrollTop: 0,
                scrollLeft: 0,
                isUntitled: true,
                externallyModified: false,
                externalChangeCount: 0,
            };
            return [...prev, newTab];
        });

        setActiveTabId(newTabId);
        return newTabId;
    }, []); // No dependency on `tabs` — uses functional updater form

    /**
     * Add a new tab with specific properties
     */
    const addTab = useCallback((tab: Tab): void => {
        setTabs(prev => [...prev, tab]);
        setActiveTabId(tab.id);
    }, []);

    /**
     * Close a tab by ID
     */
    const closeTab = useCallback((tabId: string) => {
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
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, content, isDirty: true }
                : tab
        ));
    }, []);

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

    /**
     * Update tab properties
     */
    const updateTab = useCallback((tabId: string, updates: Partial<Tab>): void => {
        setTabs(prev => prev.map(tab =>
            tab.id === tabId
                ? { ...tab, ...updates }
                : tab
        ));
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
        updateTab,
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
