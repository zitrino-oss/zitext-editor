/**
 * Editor commands shared by the Monaco context menu and the in-app Edit menu
 * (Windows/Linux), so both routes behave identically.
 *
 * Clipboard actions deliberately go through the Tauri clipboard plugin rather
 * than document.execCommand: the Windows WebView2 blocks execCommand (notably
 * paste), which silently broke right-click Copy/Paste.
 */
import type { editor, Selection } from 'monaco-editor';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

interface ClipboardTarget {
    model: editor.ITextModel;
    versionId: number;
    selections: Selection[];
}

/** Snapshot of where a clipboard command will act, taken before any await. */
function captureTarget(ed: editor.ICodeEditor): ClipboardTarget | null {
    const model = ed.getModel();
    const selections = ed.getSelections();
    if (!model || !selections || selections.length === 0) return null;
    const ordered = [...selections].sort((a, b) =>
        a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
    return { model, versionId: model.getAlternativeVersionId(), selections: ordered };
}

/** True if the editor still shows the same, unchanged document. Clipboard
 *  IPC is asynchronous: in the meantime the user can type, move the
 *  selection or switch tabs, and the edit must then not be applied. */
function stillTargets(ed: editor.ICodeEditor, target: ClipboardTarget): boolean {
    return ed.getModel() === target.model
        && !target.model.isDisposed()
        && target.model.getAlternativeVersionId() === target.versionId;
}

const isReadOnly = (ed: editor.ICodeEditor) => ed.getRawOptions().readOnly === true;

/** Lines touched by the cursors, in order and without duplicates. */
function cursorLines(target: ClipboardTarget): number[] {
    return [...new Set(target.selections.map(s => s.positionLineNumber))].sort((a, b) => a - b);
}

/**
 * What Copy/Cut put on the clipboard, following Monaco's own rules: every
 * non-empty selection joined by the document's line ending, or, when nothing
 * is selected, the whole line under each cursor (with its line break).
 */
function clipboardText(target: ClipboardTarget): { text: string; wholeLines: boolean } {
    const { model, selections } = target;
    const nonEmpty = selections.filter(s => !s.isEmpty());
    if (nonEmpty.length > 0) {
        return { text: nonEmpty.map(s => model.getValueInRange(s)).join(model.getEOL()), wholeLines: false };
    }
    const eol = model.getEOL();
    return { text: cursorLines(target).map(line => model.getLineContent(line) + eol).join(''), wholeLines: true };
}

export function getSelectedText(ed: editor.ICodeEditor): string {
    const target = captureTarget(ed);
    if (!target || target.selections.every(s => s.isEmpty())) return '';
    return clipboardText(target).text;
}

export async function copySelection(ed: editor.ICodeEditor): Promise<void> {
    const target = captureTarget(ed);
    if (!target) return;
    const { text } = clipboardText(target);
    if (!text) return;
    try {
        await writeText(text);
    } catch (error) {
        console.warn('Copy failed:', error);
    }
}

export async function cutSelection(ed: editor.ICodeEditor): Promise<void> {
    if (isReadOnly(ed)) return copySelection(ed);
    const target = captureTarget(ed);
    if (!target) return;
    const { text, wholeLines } = clipboardText(target);
    if (!text) return;
    try {
        await writeText(text);
    } catch (error) {
        console.warn('Cut failed:', error);
        return; // never delete text that did not reach the clipboard
    }
    // The text is on the clipboard; delete it only from the document and
    // selection it was copied from.
    if (!stillTargets(ed, target)) return;

    const { model } = target;
    const ranges = wholeLines
        ? lineRuns(cursorLines(target)).map(([first, last]) => last < model.getLineCount()
            ? { startLineNumber: first, startColumn: 1, endLineNumber: last + 1, endColumn: 1 }
            : first > 1
                ? { startLineNumber: first - 1, startColumn: model.getLineMaxColumn(first - 1), endLineNumber: last, endColumn: model.getLineMaxColumn(last) }
                : { startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) })
        : target.selections.filter(s => !s.isEmpty());
    try {
        ed.pushUndoStop();
        ed.executeEdits('clipboard', ranges.map(range => ({ range, text: '', forceMoveMarkers: true })));
        ed.pushUndoStop();
    } catch (error) {
        console.warn('Cut could not remove the text:', error);
    }
}

/**
 * Sorted, unique line numbers (see cursorLines) grouped into runs of
 * consecutive lines. Cutting whole
 * lines deletes one range per run: per-line ranges overlap when cursors sit
 * on the last two lines, and Monaco rejects overlapping edits.
 */
function lineRuns(lines: number[]): [number, number][] {
    const runs: [number, number][] = [];
    for (const line of lines) {
        const last = runs[runs.length - 1];
        if (last && line === last[1] + 1) last[1] = line;
        else runs.push([line, line]);
    }
    return runs;
}

export async function pasteFromClipboard(ed: editor.ICodeEditor): Promise<void> {
    if (isReadOnly(ed)) return;
    const target = captureTarget(ed);
    if (!target) return;
    let text: string | null;
    try {
        text = await readText();
    } catch (error) {
        console.warn('Paste failed:', error);
        return;
    }
    if (text == null || text === '') return;
    // Paste into the document and selections the user pasted into, not
    // whatever is focused when the clipboard read returns.
    if (!stillTargets(ed, target)) return;

    // Like Monaco's default "spread": N cursors and N pasted lines put one
    // line at each cursor; otherwise every cursor receives the full text.
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const spread = target.selections.length > 1 && lines.length === target.selections.length;
    ed.pushUndoStop();
    ed.executeEdits('clipboard', target.selections.map((range, i) => ({
        range,
        text: spread ? lines[i] : text!,
        forceMoveMarkers: true,
    })));
    ed.pushUndoStop();
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
