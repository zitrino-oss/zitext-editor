/**
 * Workspace views: the Large File / Log viewer and File Compare. They sit in
 * the tab bar next to the document tabs but are not documents, so saving,
 * autosave, crash recovery and the file watcher never see them. While one is
 * shown, App treats no document tab as focused, which keeps every tab command
 * (Save, Close Tab, formatting…) away from it.
 */

/** One side of a comparison: an open document, or a read-only snapshot
 *  (clipboard text, the saved version on disk). */
export type CompareSide =
    | { kind: 'tab'; tabId: string }
    | { kind: 'snapshot'; label: string; text: string };

export type WorkspaceView =
    | { id: string; kind: 'log'; path: string; title: string }
    | { id: string; kind: 'compare'; left: CompareSide; right: CompareSide; title: string }
    /** The Scratchpad (one at most; its text is kept by utils/scratchpad). */
    | { id: string; kind: 'scratchpad'; title: string };

import type { editor } from 'monaco-editor';

let nextViewId = 1;
export function newViewId(): string {
    return `view-${nextViewId++}`;
}

export function fileNameOf(path: string): string {
    return path.split(/[/\\]/).pop() || path;
}

/** Commands the shown view answers to (Find, Go to Line, Save) when they are
 *  pressed while it has the editor area. */
export interface ViewCommands {
    find?: () => void;
    goToLine?: () => void;
    save?: () => void;
    /** The editor the Edit menu (Undo, Cut, Paste…) acts on, if the view has one. */
    activeEditor?: () => editor.IStandaloneCodeEditor | null;
}

// Opening a file that is too big for the editor offers the Large File viewer.
// The file manager lives below App, so it asks through this hook instead of
// being handed one more callback.
type LargeFileListener = (path: string) => void;
const largeFileListeners = new Set<LargeFileListener>();

export function onLargeFileRequest(listener: LargeFileListener): () => void {
    largeFileListeners.add(listener);
    return () => { largeFileListeners.delete(listener); };
}

/** Opening a document (dialog, explorer, Recent, Find in Files, Finder,
 *  drag and drop) shows it, so a view on screen steps aside, even when the
 *  document was already the active tab. */
type OpenedListener = () => void;
const openedListeners = new Set<OpenedListener>();

export function onDocumentOpened(listener: OpenedListener): () => void {
    openedListeners.add(listener);
    return () => { openedListeners.delete(listener); };
}

export function notifyDocumentOpened(): void {
    openedListeners.forEach(listener => listener());
}

export function requestLargeFileView(path: string): boolean {
    largeFileListeners.forEach(listener => listener(path));
    return largeFileListeners.size > 0;
}
