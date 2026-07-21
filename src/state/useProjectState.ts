import { useState, useCallback, useEffect } from 'react';
import { openFolderDialog } from '../utils/fileTree';

export function useProjectState(
    initialFolder: string | null = null,
    initialCollapsed: boolean = true,
    initialWidth: number = 250,
) {
    const [openedFolder, setOpenedFolder] = useState<string | null>(initialFolder);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(initialCollapsed);
    const [sidebarWidth, setSidebarWidth] = useState(initialWidth);

    // Sync when settings load after mount (initialFolder transitions from null → saved value)
    useEffect(() => {
        setOpenedFolder(initialFolder);
        setSidebarCollapsed(initialCollapsed);
        setSidebarWidth(initialWidth);
    }, [initialFolder, initialCollapsed, initialWidth]);

    const openFolder = useCallback(async () => {
        const path = await openFolderDialog();
        if (path) {
            setOpenedFolder(path);
            setSidebarCollapsed(false);
        }
        return path;
    }, []);

    const closeFolder = useCallback(() => {
        setOpenedFolder(null);
        setSidebarCollapsed(true); // Also hide sidebar when closing
    }, []);

    const toggleSidebar = useCallback(() => {
        setSidebarCollapsed(prev => !prev);
    }, []);

    const updateSidebarWidth = useCallback((width: number) => {
        setSidebarWidth(width);
    }, []);

    return {
        openedFolder,
        sidebarCollapsed,
        sidebarWidth,
        openFolder,
        closeFolder,
        toggleSidebar,
        updateSidebarWidth,
        setOpenedFolder,
    };
}
