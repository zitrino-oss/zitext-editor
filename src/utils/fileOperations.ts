import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DiskVersion, Tab, SessionFile } from '../types';

/**
 * Request a native dialog via the menu-action chokepoint, then wait for the
 * backend to emit the result event. The backend is the only thing that can
 * actually show the dialog — the renderer cannot invoke the dialog primitives
 * directly.
 */
async function requestDialog<TName extends string>(
    action: 'open' | 'open_folder' | 'save_as',
    eventName: TName,
    extraArgs: Record<string, unknown> = {},
): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        let unlisten: UnlistenFn | null = null;
        let settled = false;

        const settle = (value: string | null) => {
            if (settled) return;
            settled = true;
            if (unlisten) unlisten();
            resolve(value);
        };

        // 5-minute timeout mirrors the Rust-side dialog timeout — if the
        // dialog never returns (window closed, OS issue), don't hang forever.
        const timer = setTimeout(() => settle(null), 5 * 60 * 1000);

        listen<string | null>(eventName, (event) => {
            clearTimeout(timer);
            settle(event.payload ?? null);
        })
            .then((un) => {
                unlisten = un;
                return invoke('request_menu_action', { action, ...extraArgs });
            })
            .catch((err) => {
                clearTimeout(timer);
                console.error(`Dialog "${action}" failed:`, err);
                settle(null);
            });
    });
}

export async function openFileDialog(): Promise<string | null> {
    return requestDialog('open', 'open-from-dialog');
}

export async function saveFileDialog(defaultName: string): Promise<string | null> {
    return requestDialog('save_as', 'save-from-dialog', { defaultName });
}

export async function openFolderDialog(): Promise<string | null> {
    return requestDialog('open_folder', 'folder-from-dialog');
}

export interface FileReadResult {
    content: string;
    size: number;
    encoding: string;
    modified: number;
    hash: string;
    identity: string;
}

export async function readFileContent(path: string): Promise<FileReadResult> {
    try {
        const result = await invoke<FileReadResult>('read_file_content', { path });
        return result;
    } catch (error) {
        // Preserve the original Rust error message (e.g. "binary file" detection)
        const msg = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));
        throw new Error(msg);
    }
}

export interface FileWriteResult {
    encoding: string;
    size: number;
    modified: number;
    hash: string;
    identity: string;
}

export async function writeFileContent(
    path: string,
    content: string,
    encoding: string = 'UTF-8',
    expectedVersion: DiskVersion | null = null,
): Promise<FileWriteResult> {
    try {
        return await invoke<FileWriteResult>('write_file_content', {
            path,
            content,
            encoding,
            expectedModified: expectedVersion?.modified,
            expectedSize: expectedVersion?.size,
            expectedHash: expectedVersion?.hash,
        });
    } catch (error) {
        console.error('Failed to write file:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to write file: ${errorMessage}`);
    }
}

export async function addRecentFile(path: string): Promise<void> {
    try {
        await invoke('add_recent_file', { path });
    } catch (error) {
        console.error('Failed to add recent file:', error);
    }
}

export async function getRecentFiles(): Promise<string[]> {
    try {
        const files = await invoke<string[]>('get_recent_files');
        return files;
    } catch (error) {
        console.error('Failed to get recent files:', error);
        return [];
    }
}

export async function rebuildNativeMenu(): Promise<void> {
    try {
        // Only rebuild on macOS
        if (navigator.platform.toUpperCase().indexOf('MAC') >= 0) {
            await invoke('rebuild_native_menu');
        }
    } catch (error) {
        // Silently fail if command not available (shouldn't happen)
        console.warn('Failed to rebuild native menu:', error);
    }
}

const MAX_UNTITLED_CONTENT_BYTES = 10 * 1024 * 1024;
// Larger cap for unsaved edits to disk-backed files preserved for crash
// recovery — most source files fit comfortably; very large dirty buffers fall
// back to a plain disk re-read on restore (losing only the unsaved delta).
const MAX_DIRTY_DISK_CONTENT_BYTES = 10 * 1024 * 1024;

// Encodes once to measure the real UTF-8 byte length. Using string `.length`
// (UTF-16 code units) under-counts multibyte content and lets a file exceed the
// intended byte cap by up to ~3x.
const byteLength = (s: string): number => new TextEncoder().encode(s).length;

export async function saveSession(tabs: Tab[], activeTabId: string | null): Promise<void> {
    try {
        const session: SessionFile[] = [];
        for (const tab of tabs) {
            if (tab.path !== null) {
                const base: SessionFile = {
                    path: tab.path,
                    cursor_line: tab.cursorLine,
                    cursor_column: tab.cursorColumn,
                    scroll_top: tab.scrollTop,
                    scroll_left: tab.scrollLeft,
                    is_active: tab.id === activeTabId,
                };
                // Preserve unsaved edits to a saved file so a crash before the
                // next manual save doesn't lose them. Non-dirty files just
                // re-read from disk on restore (no content stored).
                if (tab.isDirty && byteLength(tab.content) <= MAX_DIRTY_DISK_CONTENT_BYTES) {
                    session.push({ ...base, is_dirty: true, content: tab.content });
                } else {
                    session.push(base);
                }
                continue;
            }
            // Untitled file — skip empty scratch tabs. They hold nothing worth
            // recovering and, if persisted, reappear (and accumulate) as blank
            // untitled tabs on every launch. Only preserve untitled tabs that
            // actually contain unsaved content so crash-recovery still works.
            if (tab.content.trim().length === 0) continue;
            const content = byteLength(tab.content) <= MAX_UNTITLED_CONTENT_BYTES ? tab.content : undefined;
            session.push({
                path: tab.title,
                cursor_line: tab.cursorLine,
                cursor_column: tab.cursorColumn,
                scroll_top: tab.scrollTop,
                scroll_left: tab.scrollLeft,
                is_untitled: true,
                is_active: tab.id === activeTabId,
                content,
            });
        }

        await invoke('save_session', {
            session, activeTabPath:
                activeTabId ? tabs.find(t => t.id === activeTabId)?.path : null
        });
    } catch (error) {
        console.error('Failed to save session:', error);
    }
}

export async function getLastSession(): Promise<SessionFile[]> {
    try {
        const session = await invoke<SessionFile[]>('get_last_session');
        return session;
    } catch (error) {
        console.error('Failed to get last session:', error);
        return [];
    }
}

export function detectEOL(content: string): 'LF' | 'CRLF' {
    if (content.includes('\r\n')) {
        return 'CRLF';
    }
    return 'LF';
}

export function getFileName(path: string | null): string {
    if (!path) return 'Untitled';
    return path.split(/[\\/]/).pop() || 'Untitled';
}

export function generateUntitledName(existingTabs: Tab[]): string {
    const untitledNumbers = existingTabs
        .filter(tab => tab.path === null)
        .map(tab => {
            // Use tab.title directly — tab.path is null for untitled tabs.
            const match = tab.title.match(/Untitled-(\d+)/);
            return match ? parseInt(match[1]) : 0;
        });

    const nextNumber = untitledNumbers.length > 0
        ? Math.max(...untitledNumbers) + 1
        : 1;

    return `Untitled-${nextNumber}.txt`;
}
