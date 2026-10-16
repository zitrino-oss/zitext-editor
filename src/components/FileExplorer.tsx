import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileNode } from '../types';
import { FileTreeNode } from './FileTreeNode';
import { errorService, withoutErrorCodes } from '../services/ErrorService';
import { openFolderDialog, readTreeLevel, findFilesByName } from '../utils/fileTree';
import { FolderIconNamed } from '../utils/fileIcons';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../constants';

interface FileExplorerProps {
    folderPath: string | null;
    onFolderOpen: (path: string) => void;
    onFileSelect: (path: string) => void;
    /** File open in the focused tab; the tree marks it selected. */
    activePath?: string | null;
    /** Open tabs with unsaved changes; the tree marks them with a dot. */
    dirtyPaths?: ReadonlySet<string>;
    /** Hides the explorer; the folder stays open. */
    onClose: () => void;
    /** Closes the project folder. */
    onCloseFolder?: () => void;
    collapsed: boolean;
    width: number;
    onWidthChange: (width: number) => void;
}

async function buildTreePreservingExpansion(
    oldNodes: FileNode[],
    path: string,
): Promise<FileNode[]> {
    const fresh = await readTreeLevel(path);
    if (oldNodes.length === 0) return fresh;
    const oldByPath = new Map(oldNodes.map(node => [node.path, node]));
    return Promise.all(fresh.map(async node => {
        const old = oldByPath.get(node.path);
        if (node.isDirectory && old?.expanded) {
            const children = await buildTreePreservingExpansion(old.children || [], node.path);
            return { ...node, expanded: true, children };
        }
        return node;
    }));
}

/** Memoized: typing re-renders App, and the tree should only re-render when
 *  its own inputs change. */
export const FileExplorer = memo(function FileExplorer({
    folderPath,
    onFolderOpen,
    onFileSelect,
    activePath,
    dirtyPaths,
    onClose,
    onCloseFolder,
    collapsed,
    width,
    onWidthChange,
}: FileExplorerProps) {
    const [fileTree, setFileTree] = useState<FileNode[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isResizing, setIsResizing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    /* Bumped by Refresh so the project file count is recounted alongside the
       tree — files added on disk since the folder was opened are picked up. */
    const [refreshKey, setRefreshKey] = useState(0);

    // Every tree load (folder change, Refresh, Retry) takes a new number; a
    // load that finishes after a newer one started, or after the folder
    // changed, is dropped instead of replacing the current tree.
    const loadGeneration = useRef(0);
    const currentFolder = useRef(folderPath);
    currentFolder.current = folderPath;

    const loadFileTree = async (path: string, preserveExpanded = false) => {
        const generation = ++loadGeneration.current;
        const isCurrent = () => generation === loadGeneration.current && currentFolder.current === path;
        setLoading(true);
        setError(null);
        try {
            // On refresh, keep the previously-expanded folders open (and re-read
            // their contents) instead of collapsing the whole tree.
            const tree = await buildTreePreservingExpansion(preserveExpanded ? fileTree : [], path);
            if (isCurrent()) setFileTree(tree);
        } catch (err) {
            if (!isCurrent()) return;
            setError((err as Error).message);
            errorService.showError('Failed to load file tree', err as Error);
        } finally {
            if (isCurrent()) setLoading(false);
        }
    };

    useEffect(() => {
        if (!folderPath) {
            loadGeneration.current += 1;
            setFileTree([]);
            return;
        }
        void loadFileTree(folderPath);
        // loadFileTree reads the latest tree through its own closure; only a
        // folder change starts a load here.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [folderPath]);

    const handleOpenFolder = async () => {
        const path = await openFolderDialog();
        if (path) {
            onFolderOpen(path);
        }
    };

    const handleNodeClick = (node: FileNode) => {
        if (!node.isDirectory) {
            onFileSelect(node.path);
        }
    };

    const handleNodeExpand = async (node: FileNode) => {
        if (!node.isDirectory) return;
        // Always reload on expand so newly-created files inside the folder appear.
        const folder = folderPath;
        try {
            const children = await readTreeLevel(node.path);
            if (currentFolder.current !== folder) return;
            setFileTree(prev => updateNodeChildren(prev, node.path, children));
        } catch (err) {
            errorService.showError('Failed to load directory', err as Error);
        }
    };

    const updateNodeChildren = (tree: FileNode[], targetPath: string, children: FileNode[]): FileNode[] => {
        return tree.map(node => {
            if (node.path === targetPath) {
                return { ...node, children, expanded: true };
            }
            if (node.children) {
                return { ...node, children: updateNodeChildren(node.children, targetPath, children) };
            }
            return node;
        });
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, e.clientX));
                onWidthChange(newWidth);
            }
        };
        const handleMouseUp = () => setIsResizing(false);

        if (isResizing) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing, onWidthChange]);

    // The filter searches the whole folder on the backend, not just the
    // folders expanded so far.
    const [filterResult, setFilterResult] = useState<{ query: string; tree: FileNode[]; truncated: boolean; error?: string } | null>(null);
    useEffect(() => {
        const query = searchQuery.trim();
        if (!folderPath || !query) {
            setFilterResult(null);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            findFilesByName(folderPath, query)
                .then(result => { if (!cancelled) setFilterResult({ query, ...result }); })
                // Shown in the panel, not as a toast: this runs on every keystroke.
                .catch(err => {
                    if (!cancelled) setFilterResult({ query, tree: [], truncated: false, error: err instanceof Error ? err.message : String(err) });
                });
        }, 150);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [folderPath, searchQuery, refreshKey]);

    const filtering = searchQuery.trim().length > 0;
    const visibleTree = useMemo(
        () => (filtering ? (filterResult?.tree ?? []) : fileTree),
        [filtering, filterResult, fileTree],
    );

    /* While a filter is active the footer describes the filter, not the project,
       so it counts what the filtered tree holds. */
    const matchCount = useMemo(() => {
        const count = (nodes: FileNode[]): number => nodes.reduce(
            (total, node) => total + (node.isDirectory ? count(node.children ?? []) : node.placeholder ? 0 : 1),
            0,
        );
        return count(visibleTree);
    }, [visibleTree]);

    /* Files in the whole project, counted on the Rust side. Deliberately not
       derived from the loaded tree: directories load their children on expand,
       so a tree-derived figure climbed as folders were opened and described the
       user's browsing rather than the folder. */
    const [projectFileCount, setProjectFileCount] = useState<{ count: number; partial: boolean } | null>(null);

    useEffect(() => {
        if (!folderPath) {
            setProjectFileCount(null);
            return;
        }
        let cancelled = false;
        setProjectFileCount(null);
        invoke<{ count: number; partial: boolean }>('count_project_files', { path: folderPath })
            .then((total) => { if (!cancelled) setProjectFileCount(total); })
            .catch(() => { if (!cancelled) setProjectFileCount(null); });
        return () => { cancelled = true; };
    }, [folderPath, refreshKey]);

    const fileCount = filtering ? matchCount : projectFileCount?.count ?? null;
    // Counting stops at a time, size or depth limit: say so rather than
    // presenting a partial figure as the folder's size.
    const countIsPartial = !filtering && !!projectFileCount?.partial;

    const dirtyCount = dirtyPaths?.size ?? 0;

    if (collapsed) return null;

    return (
        <div className="file-explorer" style={{ width: `${width}px` }}>
            <div className="file-explorer-header">
                <span className="file-explorer-title">EXPLORER</span>
                <div className="file-explorer-actions">
                    <button className="file-explorer-action-btn" onClick={handleOpenFolder} title="Open Folder" aria-label="Open Folder">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                    </button>
                    <button className="file-explorer-action-btn" onClick={() => { if (folderPath) { loadFileTree(folderPath, true); setRefreshKey((k) => k + 1); } }} title="Refresh">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                    </button>
                    {folderPath && onCloseFolder && (
                        <button className="file-explorer-action-btn" onClick={onCloseFolder} title="Close Folder" aria-label="Close Folder">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                <line x1="9" y1="14" x2="15" y2="14"/>
                            </svg>
                        </button>
                    )}
                    {/* Hides the sidebar; the folder stays open (Close Folder is separate). */}
                    <button className="file-explorer-action-btn" onClick={onClose} title="Hide Explorer" aria-label="Hide Explorer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            </div>

            {folderPath && (
                <div className="file-explorer-search">
                    <input
                        type="text"
                        className="file-explorer-search-input"
                        placeholder="Filter by file name…"
                        title="Filters the tree by file name. To search text inside files, use Find in Files (Ctrl/Cmd+Shift+F)."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                        <button className="file-explorer-search-clear" onClick={() => setSearchQuery('')} title="Clear filter">
                            ×
                        </button>
                    )}
                </div>
            )}

            <div className="file-explorer-content">
                {!folderPath && (
                    <div className="file-explorer-empty">
                        <p>No folder opened</p>
                        <button className="file-explorer-open-btn" onClick={handleOpenFolder}>
                            Open Folder
                        </button>
                    </div>
                )}

                {loading && <div className="file-explorer-loading">Loading...</div>}

                {error && (
                    <div className="file-explorer-error">
                        <p>Error: {error}</p>
                        <button onClick={() => folderPath && loadFileTree(folderPath)}>Retry</button>
                    </div>
                )}

                {folderPath && !loading && !error && (
                    <div className="file-tree" role="tree" aria-label="Files">
                        <div className="file-tree-root">
                            <div className="file-tree-root-name" title={folderPath}>
                                <FolderIconNamed name={folderPath.split(/[/\\]/).pop() || ''} open />
                                {folderPath.split(/[/\\]/).pop()}
                            </div>
                        </div>
                        {filtering && filterResult?.error && (
                            <div className="file-explorer-no-results">
                                Couldn't search this folder: {withoutErrorCodes(filterResult.error)}
                            </div>
                        )}
                        {filtering && filterResult && !filterResult.error && visibleTree.length === 0 && (
                            <div className="file-explorer-no-results">
                                No file names match "{filterResult.query}".
                                <br />
                                To search text inside files, use Find in Files (Ctrl/Cmd+Shift+F).
                            </div>
                        )}
                        {filtering && filterResult?.truncated && (
                            <div className="file-explorer-no-results">
                                Showing the first matches only; type more of the name to narrow the search.
                            </div>
                        )}
                        {visibleTree.map((node, index) => (
                            <FileTreeNode
                                key={node.path}
                                node={node}
                                level={0}
                                onClick={handleNodeClick}
                                onExpand={handleNodeExpand}
                                activePath={activePath}
                                dirtyPaths={dirtyPaths}
                                tabIndex={index === 0 ? 0 : -1}
                            />
                        ))}
                    </div>
                )}
            </div>

            {folderPath && (
                <div className="file-explorer-footer">
                    {/* Blank until the walk returns, rather than showing a 0 that
                        would be read as an empty folder. */}
                    <span title={countIsPartial ? 'Counting stopped early; the folder has at least this many files.' : undefined}>
                        {fileCount === null
                            ? ''
                            : `${fileCount.toLocaleString()}${countIsPartial ? '+' : ''} ${fileCount === 1 && !countIsPartial ? 'file' : 'files'}`}
                    </span>
                    {dirtyCount > 0 && (
                        <span className="file-explorer-footer-unsaved">
                            {dirtyCount} unsaved
                        </span>
                    )}
                </div>
            )}

            <div className="file-explorer-resize-handle" onMouseDown={handleMouseDown} />
        </div>
    );
});
