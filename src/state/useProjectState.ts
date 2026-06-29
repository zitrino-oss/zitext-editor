import { useState, useCallback, useEffect } from 'react';
import { openFolderDialog } from '../utils/fileTree';

export function useProjectState(initialFolder: string | null = null) {
    const [openedFolder, setOpenedFolder] = useState<string | null>(initialFolder);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(true); // Hidden by default
    const [sidebarWidth, setSidebarWidth] = useState(250);

    // Sync when settings load after mount (initialFolder transitions from null → saved value)
    useEffect(() => {
        if (initialFolder != null && openedFolder == null) {
            setOpenedFolder(initialFolder);
            setSidebarCollapsed(false);
        }
    }, [initialFolder]); // eslint-disable-line react-hooks/exhaustive-deps

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
