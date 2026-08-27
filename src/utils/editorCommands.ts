/**
 * Editor commands shared by the Monaco context menu and the in-app Edit menu
 * (Windows/Linux), so both routes behave identically.
 *
 * Clipboard actions deliberately go through the Tauri clipboard plugin rather
 * than document.execCommand: the Windows WebView2 blocks execCommand (notably
 * paste), which silently broke right-click Copy/Paste (QA ZITEXT_V2_004).
 */
import type { editor } from 'monaco-editor';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

export function getSelectedText(ed: editor.ICodeEditor): string {
    const selection = ed.getSelection();
    const model = ed.getModel();
    if (!selection || !model || selection.isEmpty()) return '';
    return model.getValueInRange(selection);
}

export async function copySelection(ed: editor.ICodeEditor): Promise<void> {
    const text = getSelectedText(ed);
    if (text) await writeText(text);
}

export async function cutSelection(ed: editor.ICodeEditor): Promise<void> {
    const text = getSelectedText(ed);
    if (!text) return;
    await writeText(text);
    const selection = ed.getSelection();
    if (selection) {
        ed.executeEdits('clipboard', [{ range: selection, text: '', forceMoveMarkers: true }]);
    }
}

export async function pasteFromClipboard(ed: editor.ICodeEditor): Promise<void> {
    const text = await readText();
    if (text == null) return;
    const selection = ed.getSelection();
    if (selection) {
        ed.executeEdits('clipboard', [{ range: selection, text, forceMoveMarkers: true }]);
    }
    ed.focus();
}

export function selectAll(ed: editor.ICodeEditor): void {
    const model = ed.getModel();
    if (!model) return;
    ed.setSelection(model.getFullModelRange());
    ed.focus();
}

// Undo/redo go through trigger() rather than model.undo() so Monaco also
// restores the cursor and selection, not just the text.
export function undo(ed: editor.ICodeEditor): void {
    ed.focus();
    ed.trigger('menu', 'undo', null);
}

export function redo(ed: editor.ICodeEditor): void {
    ed.focus();
    ed.trigger('menu', 'redo', null);
}

export function toggleLineComment(ed: editor.ICodeEditor): void {
    ed.focus();
    ed.trigger('menu', 'editor.action.commentLine', null);
}

/**
 * Formats the document. Monaco only ships formatters for some languages
 * (JSON/HTML/CSS/JS/TS); for anything else this resolves without changing the
 * buffer, which matches how the editor's own command behaves.
 */
export async function formatDocument(ed: editor.ICodeEditor): Promise<void> {
    ed.focus();
    await ed.getAction('editor.action.formatDocument')?.run();
}
