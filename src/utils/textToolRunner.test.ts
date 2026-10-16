/**
 * Text and Data Tools applied to an editor: which text a tool works on
 * (selection, its whole lines, or the document), one undo step, read-only
 * documents untouched, results in a new tab or on the clipboard.
 */
import { describe, expect, it, vi } from 'vitest';
import type { editor } from 'monaco-editor';
import { runTextTool, type ToolContext } from './textToolRunner';

interface Range { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

function fakeEditor(text: string, selections: Range[] = [], readOnly = false) {
    const lines = text.split('\n');
    const offsetOf = (line: number, column: number) =>
        lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + column - 1;
    const model = {
        getEOL: () => '\n',
        getValue: () => lines.join('\n'),
        getLineContent: (line: number) => lines[line - 1],
        getLineMaxColumn: (line: number) => lines[line - 1].length + 1,
        getLineCount: () => lines.length,
        getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines[lines.length - 1].length + 1 }),
        getValueInRange: (r: Range) => lines.join('\n').slice(offsetOf(r.startLineNumber, r.startColumn), offsetOf(r.endLineNumber, r.endColumn)),
    };
    const undoStops: number[] = [];
    const target = {
        edits: 0,
        getModel: () => model,
        getRawOptions: () => ({ readOnly }),
        getSelections: () => selections.map(s => ({ ...s, isEmpty: () => s.startLineNumber === s.endLineNumber && s.startColumn === s.endColumn })),
        pushUndoStop: () => { undoStops.push(target.edits); },
        executeEdits: (_source: string, edits: { range: Range; text: string }[]) => {
            target.edits++;
            const full = lines.join('\n');
            let next = full;
            for (const edit of [...edits].sort((a, b) => offsetOf(b.range.startLineNumber, b.range.startColumn) - offsetOf(a.range.startLineNumber, a.range.startColumn))) {
                next = next.slice(0, offsetOf(edit.range.startLineNumber, edit.range.startColumn)) + edit.text + next.slice(offsetOf(edit.range.endLineNumber, edit.range.endColumn));
            }
            lines.splice(0, lines.length, ...next.split('\n'));
            return true;
        },
    };
    return { target: target as unknown as editor.IStandaloneCodeEditor & { edits: number }, text: () => lines.join('\n'), undoStops };
}

function context(target: editor.IStandaloneCodeEditor | null, input?: ToolContext['input']) {
    const ctx = {
        editor: target,
        openInNewTab: vi.fn(),
        copyToClipboard: vi.fn(async () => undefined),
        notify: vi.fn(),
        input,
    };
    return ctx;
}

const range = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) =>
    ({ startLineNumber, startColumn, endLineNumber, endColumn });

describe('text tools on the editor', () => {
    it('sort the whole document as one undo step when nothing is selected', async () => {
        const fake = fakeEditor('c\na\nb');
        await runTextTool('sortAsc', context(fake.target));
        expect(fake.text()).toBe('a\nb\nc');
        expect(fake.undoStops).toEqual([0, 1]);
    });

    it('keep the final line break at the end of the document', async () => {
        const sorted = fakeEditor('b\na\n');
        await runTextTool('sortAsc', context(sorted.target));
        expect(sorted.text()).toBe('a\nb\n');
        const reversed = fakeEditor('a\nb\n');
        await runTextTool('reverse', context(reversed.target));
        expect(reversed.text()).toBe('b\na\n');
        const cleaned = fakeEditor('a\n\nb\n');
        await runTextTool('removeEmpty', context(cleaned.target));
        expect(cleaned.text()).toBe('a\nb\n');
        const counted = fakeEditor('x\nx\n');
        const ctx = context(counted.target);
        await runTextTool('countUnique', ctx);
        expect(ctx.openInNewTab).toHaveBeenCalledWith('2 lines, 1 unique\n\n2\tx', 'plaintext');
    });

    it('work on the whole lines of a selection, not past a selection ending at column 1', async () => {
        const fake = fakeEditor('z\nc\na\nb\ny', [range(2, 2, 5, 1)]);
        await runTextTool('sortAsc', context(fake.target));
        expect(fake.text()).toBe('z\na\nb\nc\ny');
    });

    it('change only the selected text for case and encoding tools', async () => {
        const fake = fakeEditor('keep this, shout that', [range(1, 12, 1, 22)]);
        await runTextTool('upper', context(fake.target));
        expect(fake.text()).toBe('keep this, SHOUT THAT');
        const encoded = fakeEditor('a b&c');
        await runTextTool('urlEncode', context(encoded.target));
        expect(encoded.text()).toBe('a%20b%26c');
    });

    it('never change a read-only document', async () => {
        const fake = fakeEditor('b\na', [], true);
        const ctx = context(fake.target);
        await runTextTool('sortAsc', ctx);
        expect(fake.text()).toBe('b\na');
        expect(ctx.notify).toHaveBeenCalledWith('warning', expect.stringContaining('read-only'));
    });

    it('leave the document untouched when a tool fails part-way', async () => {
        const fake = fakeEditor('aGk=\n!!!', [range(1, 1, 1, 5), range(2, 1, 2, 4)]);
        const ctx = context(fake.target);
        await runTextTool('base64Decode', ctx);
        expect(fake.text()).toBe('aGk=\n!!!');
        expect(ctx.notify).toHaveBeenCalledWith('error', "This isn't valid Base64.");
    });

    it('open conversions and reports in a new tab, leaving the original', async () => {
        const fake = fakeEditor('id,name\n1,Ann');
        const ctx = context(fake.target);
        await runTextTool('csvToJson', ctx);
        expect(ctx.openInNewTab).toHaveBeenCalledWith(JSON.stringify([{ id: '1', name: 'Ann' }], null, 2), 'json');
        await runTextTool('countUnique', ctx);
        expect(ctx.openInNewTab).toHaveBeenLastCalledWith('2 lines, 2 unique\n\n1\tid,name\n1\t1,Ann', 'plaintext');
        expect(fake.text()).toBe('id,name\n1,Ann');
    });

    it('copy checksums to the clipboard', async () => {
        const fake = fakeEditor('abc');
        const ctx = context(fake.target);
        await runTextTool('md5', ctx);
        expect(ctx.copyToClipboard).toHaveBeenCalledWith('900150983cd24fb0d6963f7d28e17f72');
        expect(fake.text()).toBe('abc');
    });

    it('ask for a selection before converting a timestamp, then replace it', async () => {
        const none = fakeEditor('at 1696700000 ok');
        const ctx = context(none.target);
        await runTextTool('unixToDate', ctx);
        expect(ctx.notify).toHaveBeenCalledWith('warning', 'Select a Unix timestamp first.');
        const fake = fakeEditor('at 1696700000 ok', [range(1, 4, 1, 14)]);
        await runTextTool('unixToDate', context(fake.target));
        expect(fake.text()).toBe('at 2023-10-07T17:33:20Z ok');
    });

    it('split lines at the delimiter given', async () => {
        const fake = fakeEditor('a, b, c');
        await runTextTool('split', context(fake.target, { delimiter: ',', trimPieces: true }));
        expect(fake.text()).toBe('a\nb\nc');
    });

    it('insert a UUID at each cursor', async () => {
        const fake = fakeEditor('x\ny', [range(1, 2, 1, 2), range(2, 2, 2, 2)]);
        await runTextTool('uuid', context(fake.target));
        const [first, second] = fake.text().split('\n');
        expect(first).toMatch(/^x[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(second.slice(1)).not.toBe(first.slice(1));
    });

    it('say so when there is no document', async () => {
        const ctx = context(null);
        await runTextTool('sortAsc', ctx);
        expect(ctx.notify).toHaveBeenCalledWith('warning', 'Open a document first.');
    });
});
