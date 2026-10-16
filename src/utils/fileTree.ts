import { invoke } from '@tauri-apps/api/core';
import { openFolderDialog as openFolderDialogViaMenu } from './fileOperations';
import type { FileNode } from '../types';

interface FileEntry {
    name: string;
    path: string;
    is_directory: boolean;
    size?: number;
    modified?: number;
}

/**
 * Forward slashes, and Windows verbatim paths in ordinary form:
 * `\\?\C:\x` → `C:/x`, `\\?\UNC\server\share\x` → `//server/share/x`.
 */
export function normalizeTreePath(p: string): string {
    const normalized = p.replace(/\\/g, '/');
    if (/^\/\/\?\/UNC\//i.test(normalized)) return '//' + normalized.substring(8);
    if (normalized.startsWith('//?/')) return normalized.substring(4);
    return normalized;
}

/**
 * Build a hierarchical file tree from flat file entries
 */
export function buildFileTree(entries: FileEntry[], rootPath: string): FileNode[] {
    const tree: FileNode[] = [];
    const pathMap = new Map<string, FileNode>();
    
    const normalizedRoot = normalizeTreePath(rootPath);

    // Sort entries: parents before their contents (a multi-level listing,
    // such as the explorer filter's, would otherwise drop a folder that sorts
    // before its parent), then directories first, then alphabetically.
    const depth = (entry: FileEntry) => normalizeTreePath(entry.path).split('/').length;
    const sortedEntries = [...entries].sort((a, b) => {
        if (depth(a) !== depth(b)) return depth(a) - depth(b);
        if (a.is_directory !== b.is_directory) {
            return a.is_directory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });

    for (const entry of sortedEntries) {
        const normalizedPath = normalizeTreePath(entry.path);
        const node: FileNode = {
            name: entry.name,
            path: normalizedPath,
            isDirectory: entry.is_directory,
            size: entry.size,
            modified: entry.modified,
            children: entry.is_directory ? [] : undefined,
            expanded: false,
        };

        pathMap.set(normalizedPath, node);

        // Find parent
        const parentPath = getParentPath(normalizedPath);
        if (parentPath === normalizedRoot || !parentPath) {
            // Root level
            tree.push(node);
        } else {
            // Add to parent's children
            const parent = pathMap.get(parentPath);
            if (parent && parent.children) {
                parent.children.push(node);
            }
        }
    }

    return tree;
}

/**
 * Get parent directory path
 */
function getParentPath(path: string): string {
    const normalizedPath = normalizeTreePath(path);
    const parts = normalizedPath.split('/');
    if (parts.length > 0) {
        parts.pop();
    }
    
    if (parts.length === 0) {
        return '';
    }

    if (parts.length === 1 && parts[0].endsWith(':')) {
        // Handle Windows drive root: "C:/"
        return parts[0] + '/';
    }
    return parts.join('/');
}

export interface DirectoryListing {
    entries: FileEntry[];
    /** The folder has more entries than the explorer lists. */
    truncated: boolean;
    /** Symbolic links left out for safety (they could point outside the folder). */
    hiddenLinks?: number;
}

/**
 * Read directory from Tauri backend
 */
export async function readDirectory(path: string, recursive: boolean = false): Promise<DirectoryListing> {
    try {
        return await invoke<DirectoryListing>('read_directory', { path, recursive });
    } catch (error) {
        console.error('Failed to read directory:', error);
        throw error;
    }
}

/** A non-clickable row saying a folder was listed only in part. */
export function truncationNote(folderPath: string): FileNode {
    return {
        name: 'Only the first 5,000 items are shown',
        path: `${normalizeTreePath(folderPath)}/\u0000truncated`,
        isDirectory: false,
        placeholder: true,
    };
}

/** A non-clickable row saying symbolic links in a folder are not shown. */
export function hiddenLinksNote(folderPath: string, count: number): FileNode {
    return {
        name: `${count.toLocaleString()} symbolic link${count === 1 ? '' : 's'} not shown`,
        path: `${normalizeTreePath(folderPath)}/\u0000links`,
        isDirectory: false,
        placeholder: true,
    };
}

/** Lists a folder as tree nodes, with notes when the listing was cut short
 *  or symbolic links were left out. */
export async function readTreeLevel(path: string): Promise<FileNode[]> {
    const listing = await readDirectory(path, false);
    const nodes = buildFileTree(listing.entries, path);
    if (listing.hiddenLinks) nodes.push(hiddenLinksNote(path, listing.hiddenLinks));
    return listing.truncated ? [...nodes, truncationNote(path)] : nodes;
}

/** Explorer filter: files whose names match anywhere in the folder, with the
 *  folders leading to them expanded. */
export async function findFilesByName(folder: string, query: string): Promise<{ tree: FileNode[]; truncated: boolean }> {
    const result = await invoke<DirectoryListing>('find_files_by_name', { folder, query });
    const expand = (nodes: FileNode[]): FileNode[] => nodes.map(node => node.isDirectory
        ? { ...node, expanded: true, children: expand(node.children ?? []) }
        : node);
    return { tree: expand(buildFileTree(result.entries, folder)), truncated: result.truncated };
}

/**
 * Open folder dialog and return selected path. Routes through the
 * menu-action chokepoint (see fileOperations.openFolderDialog).
 */
export async function openFolderDialog(): Promise<string | null> {
    return openFolderDialogViaMenu();
}

/**
 * Get file icon based on extension
 */
export function getFileIcon(fileName: string, isDirectory: boolean): string {
    if (isDirectory) {
        return '📁';
    }

    const ext = fileName.split('.').pop()?.toLowerCase();

    const iconMap: Record<string, string> = {
        // Code
        js: '📜',
        jsx: '⚛️',
        ts: '📘',
        tsx: '⚛️',
        py: '🐍',
        java: '☕',
        c: '©️',
        cpp: '©️',
        cs: '#️⃣',
        go: '🐹',
        rs: '🦀',
        php: '🐘',
        rb: '💎',
        swift: '🦅',
        kt: '🅺',

        // Web
        html: '🌐',
        css: '🎨',
        scss: '🎨',
        sass: '🎨',

        // Data
        json: '📋',
        xml: '📋',
        yaml: '📋',
        yml: '📋',
        toml: '📋',

        // Docs
        md: '📝',
        txt: '📄',
        pdf: '📕',

        // Images
        png: '🖼️',
        jpg: '🖼️',
        jpeg: '🖼️',
        gif: '🖼️',
        svg: '🖼️',

        // Other
        zip: '📦',
        tar: '📦',
        gz: '📦',
    };

    return iconMap[ext || ''] || '📄';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes?: number): string {
    if (bytes === undefined) return '';

    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Toggle node expansion
 */
export function toggleNodeExpansion(tree: FileNode[], path: string): FileNode[] {
    return tree.map(node => {
        if (node.path === path) {
            return { ...node, expanded: !node.expanded };
        }
        if (node.children) {
            return { ...node, children: toggleNodeExpansion(node.children, path) };
        }
        return node;
    });
}
