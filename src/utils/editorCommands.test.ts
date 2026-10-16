// @vitest-environment jsdom
/**
 * Clipboard commands: multi-cursor and empty-selection
 * semantics, and no edits after the document/selection changed while the
 * clipboard IPC was pending. Runs on a real Monaco text model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const clipboard = vi.hoisted(() => {
    (document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => false;
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false, media: query, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
    return { readText: vi.fn(), writeText: vi.fn() };
});
vi.mock('@tauri-apps/plugin-clipboard-manager', () => clipboard);

import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { copySelection, cutSelection, pasteFromClipboard } from './editorCommands';

const models: editor.ITextModel[] = [];
afterEach(() => { models.splice(0).forEach(m => m.dispose()); vi.clearAllMocks(); });

function model(text: string) {
    const m = monaco.editor.createModel(text);
    models.push(m);
    return m;
}

function fakeEditor(initial: editor.ITextModel, selections: monaco.Selection[], readOnly = false) {
    let current = initial;
    let sel = selections;
    const ed = {
        getModel: () => current,
        getSelections: () => sel,
        getSelection: () => sel[0] ?? null,
        getRawOptions: () => ({ readOnly }),
        pushUndoStop: () => { current.pushStackElement(); return true; },
        executeEdits: (_s: string, edits: { range: monaco.IRange; text: string }[]) => {
            current.pushEditOperations([], edits.map(e => ({ range: e.range, text: e.text })), () => null);
            return true;
        },
        focus: () => {},
        switchTo(next: editor.ITextModel, nextSel: monaco.Selection[]) { current = next; sel = nextSel; },
    };
    return ed as unknown as editor.ICodeEditor & { switchTo: typeof ed.switchTo };
}

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

const S = (l1: number, c1: number, l2: number, c2: number) => new monaco.Selection(l1, c1, l2, c2);

describe('copy', () => {
    it('copies every selection, joined by the line ending', async () => {
        const ed = fakeEditor(model('foo bar baz'), [S(1, 1, 1, 4), S(1, 9, 1, 12)]);
        clipboard.writeText.mockResolvedValue(undefined);
        await copySelection(ed);
        expect(clipboard.writeText).toHaveBeenCalledWith('foo\nbaz');
    });

    it('copies the whole line when nothing is selected', async () => {
        const ed = fakeEditor(model('first\nsecond\nthird'), [S(2, 3, 2, 3)]);
        clipboard.writeText.mockResolvedValue(undefined);
        await copySelection(ed);
        expect(clipboard.writeText).toHaveBeenCalledWith('second\n');
    });
});

describe('cut', () => {
    it('removes every selection in one undo step', async () => {
        const m = model('foo bar baz');
        const ed = fakeEditor(m, [S(1, 1, 1, 4), S(1, 9, 1, 12)]);
        clipboard.writeText.mockResolvedValue(undefined);
        await cutSelection(ed);
        expect(m.getValue()).toBe(' bar ');
        m.undo();
        expect(m.getValue()).toBe('foo bar baz');
    });

    it('cuts the whole line when nothing is selected', async () => {
        const m = model('first\nsecond\nthird');
        const ed = fakeEditor(m, [S(2, 2, 2, 2)]);
        clipboard.writeText.mockResolvedValue(undefined);
        await cutSelection(ed);
        expect(m.getValue()).toBe('first\nthird');
    });

    it('cuts whole lines under cursors on the last two lines (no overlapping edits)', async () => {
        const m = model('a\nb\nc');
        const ed = fakeEditor(m, [S(2, 1, 2, 1), S(3, 1, 3, 1)]);
        clipboard.writeText.mockResolvedValue(undefined);
        await cutSelection(ed);
        expect(m.getValue()).toBe('a');
    });

    it('does not delete anything if the document changed while copying', async () => {
        const m = model('keep this text');
        const ed = fakeEditor(m, [S(1, 1, 1, 5)]);
        const write = deferred<void>();
        clipboard.writeText.mockReturnValue(write.promise);
        const cut = cutSelection(ed);
        m.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: '>> ' }], () => null);
        write.resolve();
        await cut;
        expect(m.getValue()).toBe('>> keep this text');
    });

    it('does not delete from another tab the user switched to', async () => {
        const first = model('first doc');
        const second = model('second doc');
        const ed = fakeEditor(first, [S(1, 1, 1, 6)]);
        const write = deferred<void>();
        clipboard.writeText.mockReturnValue(write.promise);
        const cut = cutSelection(ed);
        ed.switchTo(second, [S(1, 1, 1, 7)]);
        write.resolve();
        await cut;
        expect(first.getValue()).toBe('first doc');
        expect(second.getValue()).toBe('second doc');
    });

    it('never deletes text that failed to reach the clipboard', async () => {
        const m = model('precious');
        const ed = fakeEditor(m, [S(1, 1, 1, 9)]);
        clipboard.writeText.mockRejectedValue(new Error('clipboard unavailable'));
        await expect(cutSelection(ed)).resolves.toBeUndefined();
        expect(m.getValue()).toBe('precious');
    });

    it('only copies in a read-only editor', async () => {
        const m = model('read only');
        const ed = fakeEditor(m, [S(1, 1, 1, 5)], true);
        clipboard.writeText.mockResolvedValue(undefined);
        await cutSelection(ed);
        expect(clipboard.writeText).toHaveBeenCalledWith('read');
        expect(m.getValue()).toBe('read only');
    });
});

describe('paste', () => {
    it('does not paste into another tab the user switched to', async () => {
        const first = model('first');
        const second = model('second');
        const ed = fakeEditor(first, [S(1, 6, 1, 6)]);
        const read = deferred<string>();
        clipboard.readText.mockReturnValue(read.promise);
        const paste = pasteFromClipboard(ed);
        ed.switchTo(second, [S(1, 1, 1, 1)]);
        read.resolve('!');
        await paste;
        expect(second.getValue()).toBe('second');
        expect(first.getValue()).toBe('first');
    });

    it('spreads one line per cursor when the counts match', async () => {
        const m = model('a\nb\nc');
        const ed = fakeEditor(m, [S(1, 2, 1, 2), S(2, 2, 2, 2), S(3, 2, 3, 2)]);
        clipboard.readText.mockResolvedValue('1\n2\n3');
        await pasteFromClipboard(ed);
        expect(m.getValue()).toBe('a1\nb2\nc3');
    });

    it('pastes the full text at every cursor otherwise', async () => {
        const m = model('a\nb');
        const ed = fakeEditor(m, [S(1, 2, 1, 2), S(2, 2, 2, 2)]);
        clipboard.readText.mockResolvedValue('x');
        await pasteFromClipboard(ed);
        expect(m.getValue()).toBe('ax\nbx');
    });

    it('does nothing in a read-only editor', async () => {
        const m = model('read only');
        const ed = fakeEditor(m, [S(1, 1, 1, 1)], true);
        clipboard.readText.mockResolvedValue('x');
        await pasteFromClipboard(ed);
        expect(clipboard.readText).not.toHaveBeenCalled();
        expect(m.getValue()).toBe('read only');
    });
});
