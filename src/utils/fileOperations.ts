import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DiskVersion, Tab, SessionFile } from '../types';
import { errorService } from '../services/ErrorService';
import { buildSessionSnapshot } from './sessionSnapshot';
import { reportPersistenceFailure } from './persistenceErrors';

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
    /** The path as the backend resolved it (symlinks, letter case). */
    path?: string;
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
    allowReadOnly = false,
): Promise<FileWriteResult> {
    try {
        return await invoke<FileWriteResult>('write_file_content', {
            path,
            content,
            encoding,
            expectedModified: expectedVersion?.modified,
            expectedSize: expectedVersion?.size,
            expectedHash: expectedVersion?.hash,
            allowReadOnly,
        });
    } catch (error) {
        console.error('Failed to write file:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        // The backend's own message may already say so.
        throw new Error(errorMessage.startsWith('Failed to write file')
            ? errorMessage
            : `Failed to write file: ${errorMessage}`);
    }
}

export async function addRecentFile(path: string): Promise<void> {
    try {
        await invoke('add_recent_file', { path });
    } catch (error) {
        reportPersistenceFailure('recent files', error);
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

// Shown once per distinct problem, not on every 30-second snapshot.
let lastOmittedWarning = '';
let snapshotFailureWarned = false;

// Snapshots are written one at a time, in the order they were taken: two
// overlapping writes could otherwise finish out of order and leave the older
// snapshot stored.
let snapshotQueue: Promise<void> = Promise.resolve();

export function saveSession(tabs: Tab[], activeTabId: string | null): Promise<void> {
    const next = snapshotQueue.then(() => writeSessionSnapshot(tabs, activeTabId));
    snapshotQueue = next.catch(() => {});
    return next;
}

async function writeSessionSnapshot(tabs: Tab[], activeTabId: string | null): Promise<void> {
    const { session, omitted } = buildSessionSnapshot(tabs, activeTabId);

    const omittedKey = omitted.join('\n');
    if (omitted.length > 0 && omittedKey !== lastOmittedWarning) {
        const names = omitted.slice(0, 3).map(name => `"${name}"`).join(', ');
        const more = omitted.length > 3 ? ` and ${omitted.length - 3} more` : '';
        errorService.showWarning(
            `Crash recovery can't keep a copy of ${omitted.length} unsaved document(s) (${names}${more}) ` +
            'because they are too large. Save them to protect your changes.',
        );
    }
    lastOmittedWarning = omittedKey;

    try {
        const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined;
        await invoke('save_session', { session, activeTabPath: activeTab?.path ?? null });
        snapshotFailureWarned = false;
    } catch (error) {
        console.error('Failed to save session:', error);
        if (!snapshotFailureWarned) {
            snapshotFailureWarned = true;
            const message = error instanceof Error ? error.message : String(error);
            errorService.showWarning(
                `Crash recovery snapshots are failing (${message}). Save your work to keep it safe.`,
            );
        }
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

export type LineEnding = 'LF' | 'CRLF' | 'Mixed';

export interface LineEndingInfo {
    /** What the status bar shows: Mixed when the file uses more than one style. */
    eol: LineEnding;
    /** The single style the editor converts the text to (Monaco keeps one). */
    normalizedTo: 'LF' | 'CRLF';
    mixed: boolean;
}

/**
 * Line endings of a document. Monaco stores one line-ending
 * style per document: a file mixing styles, or using old Mac CR-only line
 * breaks, is converted to the majority style (CR counts toward CRLF).
 */
export function analyzeLineEndings(content: string): LineEndingInfo {
    let crlf = 0;
    let lf = 0;
    let cr = 0;
    for (let i = 0; i < content.length; i++) {
        const ch = content.charCodeAt(i);
        if (ch === 13) {
            if (content.charCodeAt(i + 1) === 10) { crlf++; i++; } else { cr++; }
        } else if (ch === 10) {
            lf++;
        }
    }
    const total = crlf + lf + cr;
    const normalizedTo = total > 0 && cr + crlf > total / 2 ? 'CRLF' : 'LF';
    const mixed = cr > 0 || (crlf > 0 && lf > 0);
    return { eol: mixed ? 'Mixed' : normalizedTo, normalizedTo, mixed };
}

export function detectEOL(content: string): LineEnding {
    return analyzeLineEndings(content).eol;
}

/** Number of lines, counted without splitting the text into an array. */
export function countLines(content: string): number {
    let lines = 1;
    for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) lines++;
    return lines;
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
