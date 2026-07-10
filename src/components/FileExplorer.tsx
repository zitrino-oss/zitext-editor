import { useState, useEffect, useMemo } from 'react';
import type { FileNode } from '../types';
import { FileTreeNode } from './FileTreeNode';
import { errorService } from '../services/ErrorService';
import { openFolderDialog, readDirectory, buildFileTree } from '../utils/fileTree';
import { FolderIconNamed } from '../utils/fileIcons';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../constants';

interface FileExplorerProps {
    folderPath: string | null;
    onFolderOpen: (path: string) => void;
    onFileSelect: (path: string) => void;
    onClose: () => void;
    collapsed: boolean;
    width: number;
    onWidthChange: (width: number) => void;
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
    if (!query) return nodes;
    const lower = query.toLowerCase();
    const result: FileNode[] = [];
    for (const node of nodes) {
        if (node.isDirectory) {
            const filteredChildren = filterTree(node.children || [], query);
            if (filteredChildren.length > 0) {
                result.push({ ...node, children: filteredChildren, expanded: true });
            }
        } else if (node.name.toLowerCase().includes(lower)) {
            result.push(node);
        }
    }
    return result;
}

export function FileExplorer({
    folderPath,
    onFolderOpen,
    onFileSelect,
    onClose,
    collapsed,
    width,
    onWidthChange,
}: FileExplorerProps) {
    const [fileTree, setFileTree] = useState<FileNode[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isResizing, setIsResizing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        if (folderPath) {
            loadFileTree(folderPath);
        } else {
            setFileTree([]);
        }
    }, [folderPath]);

    const loadFileTree = async (path: string, preserveExpanded = false) => {
        setLoading(true);
        setError(null);
        try {
            // On refresh, keep the previously-expanded folders open (and re-read
            // their contents) instead of collapsing the whole tree.
            const tree = await buildTreePreservingExpansion(preserveExpanded ? fileTree : [], path);
            setFileTree(tree);
        } catch (err) {
            setError((err as Error).message);
            errorService.showError('Failed to load file tree', err as Error);
        } finally {
            setLoading(false);
        }
    };

    // Re-read `path` and, for any directory that was expanded in `oldNodes`,
    // recursively re-read and re-expand it so refresh preserves the tree's open state.
    const buildTreePreservingExpansion = async (oldNodes: FileNode[], path: string): Promise<FileNode[]> => {
        const entries = await readDirectory(path, false);
        const fresh = buildFileTree(entries, path);
        if (oldNodes.length === 0) return fresh;
        const oldByPath = new Map(oldNodes.map(n => [n.path, n]));
        return Promise.all(fresh.map(async node => {
            const old = oldByPath.get(node.path);
            if (node.isDirectory && old?.expanded) {
                const children = await buildTreePreservingExpansion(old.children || [], node.path);
                return { ...node, expanded: true, children };
            }
            return node;
        }));
    };

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
        try {
            const entries = await readDirectory(node.path, false);
            const children = buildFileTree(entries, node.path);
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

    const visibleTree = useMemo(
        () => filterTree(fileTree, searchQuery),
        [fileTree, searchQuery]
    );

    if (collapsed) return null;

    return (
        <div className="file-explorer" style={{ width: `${width}px` }}>
            <div className="file-explorer-header">
                <span className="file-explorer-title">EXPLORER</span>
                <div className="file-explorer-actions">
                    <button className="file-explorer-action-btn" onClick={handleOpenFolder} title="Open Folder">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                    </button>
                    <button className="file-explorer-action-btn" onClick={() => folderPath && loadFileTree(folderPath, true)} title="Refresh">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                    </button>
                    <button className="file-explorer-action-btn" onClick={onClose} title="Close Explorer">
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
                    <div className="file-tree">
                        <div className="file-tree-root">
                            <div className="file-tree-root-name" title={folderPath}>
                                <FolderIconNamed name={folderPath.split(/[/\\]/).pop() || ''} open />
                                {folderPath.split(/[/\\]/).pop()}
                            </div>
                        </div>
                        {visibleTree.length === 0 && searchQuery && (
                            <div className="file-explorer-no-results">
                                No file names match "{searchQuery}".
                                <br />
                                To search text inside files, use Find in Files (Ctrl/Cmd+Shift+F).
                            </div>
                        )}
                        {visibleTree.map(node => (
                            <FileTreeNode
                                key={node.path}
                                node={node}
                                level={0}
                                onClick={handleNodeClick}
                                onExpand={handleNodeExpand}
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className="file-explorer-resize-handle" onMouseDown={handleMouseDown} />
        </div>
    );
}
