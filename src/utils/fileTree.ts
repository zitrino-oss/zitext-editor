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
 * Build a hierarchical file tree from flat file entries
 */
export function buildFileTree(entries: FileEntry[], rootPath: string): FileNode[] {
    const tree: FileNode[] = [];
    const pathMap = new Map<string, FileNode>();
    
    // Helper to normalize paths consistently
    const normalize = (p: string) => {
        let normalized = p.replace(/\\/g, '/');
        // Strip Windows UNC prefix if present
        if (normalized.startsWith('//?/')) {
            normalized = normalized.substring(4);
        }
        return normalized;
    };

    const normalizedRoot = normalize(rootPath);

    // Sort entries: directories first, then alphabetically
    const sortedEntries = [...entries].sort((a, b) => {
        if (a.is_directory !== b.is_directory) {
            return a.is_directory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });

    for (const entry of sortedEntries) {
        const normalizedPath = normalize(entry.path);
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
    // Helper to normalize paths consistently (duplicate of the one in buildFileTree for now, or could be extracted)
    const normalize = (p: string) => {
        let normalized = p.replace(/\\/g, '/');
        if (normalized.startsWith('//?/')) {
            normalized = normalized.substring(4);
        }
        return normalized;
    };

    const normalizedPath = normalize(path);
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

/**
 * Read directory from Tauri backend
 */
export async function readDirectory(path: string, recursive: boolean = false): Promise<FileEntry[]> {
    try {
        return await invoke<FileEntry[]>('read_directory', { path, recursive });
    } catch (error) {
        console.error('Failed to read directory:', error);
        throw error;
    }
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
