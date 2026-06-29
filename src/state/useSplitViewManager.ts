import { useState, useCallback } from 'react';

/**
 * useSplitViewManager - Manages split view state
 *
 * Handles the state for side-by-side editor panes, including:
 * - Toggle split view on/off
 * - Track which tab is shown in right pane
 * - Swap panes
 * - Close right pane
 */
export function useSplitViewManager() {
    const [splitViewEnabled, setSplitViewEnabled] = useState(false);
    const [rightPaneTabId, setRightPaneTabId] = useState<string | null>(null);

    /**
     * Toggle split view on/off
     */
    const toggleSplitView = useCallback(() => {
        setSplitViewEnabled(prev => {
            // When disabling, also clear the right pane in the same batch.
            if (prev) setRightPaneTabId(null);
            return !prev;
        });
    }, []);

    /**
     * Open a specific tab in the right pane
     */
    const openInRightPane = useCallback((tabId: string) => {
        setRightPaneTabId(tabId);
        // Automatically enable split view when opening in right pane
        if (!splitViewEnabled) {
            setSplitViewEnabled(true);
        }
    }, [splitViewEnabled]);

    /**
     * Close the right pane (keeps split view enabled but clears the tab)
     */
    const closeRightPane = useCallback(() => {
        setRightPaneTabId(null);
    }, []);

    /**
     * Swap the left and right panes
     */
    const swapPanes = useCallback((currentLeftTabId: string | undefined) => {
        if (!currentLeftTabId || !rightPaneTabId) return;

        // Swap the tab IDs
        setRightPaneTabId(currentLeftTabId);
        return rightPaneTabId; // Return the right pane tab to become the new active tab
    }, [rightPaneTabId]);

    /**
     * Disable split view completely
     */
    const disableSplitView = useCallback(() => {
        setSplitViewEnabled(false);
        setRightPaneTabId(null);
    }, []);

    return {
        splitViewEnabled,
        rightPaneTabId,
        toggleSplitView,
        openInRightPane,
        closeRightPane,
        swapPanes,
        disableSplitView,
    };
}
