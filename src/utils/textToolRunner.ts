/**
 * Runs a Text and Data Tool on the focused editor (utils/textToolList).
 *
 * - Line tools work on the whole lines of the selection, or on the document
 *   when nothing is selected.
 * - Case and encoding tools replace each selection, or the document.
 * - Conversions, the line-count report and JWT decoding open their result in
 *   a new tab, so the original is never changed.
 * - Checksums are copied to the clipboard.
 *
 * Every change is one undo step, and read-only documents are never changed.
 */
import type { editor, IRange } from 'monaco-editor';
import {
    applyCodec, changeCase, convertDelimited, countUniqueLines, dateToUnix, decodeJwt, delimitedToJson,
    formatLineCounts, jsonToDelimited, md5Hex, minifyXml, sha256Hex, splitLines, transformLines, unixToIso,
    type CaseOp, type CodecOp, type LineOp,
} from './textTools';
import type { TextToolId } from './textToolList';

export interface ToolContext {
    editor: editor.IStandaloneCodeEditor | null;
    openInNewTab: (content: string, language: string) => void;
    copyToClipboard: (text: string) => Promise<void>;
    notify: (kind: 'success' | 'warning' | 'error', message: string) => void;
    /** Extra input some tools ask for (Split Lines: the delimiter). */
    input?: { delimiter?: string; trimPieces?: boolean };
}

const LINE_OPS: Partial<Record<TextToolId, LineOp>> = {
    sortAsc: 'sortAsc', sortDesc: 'sortDesc', sortNumeric: 'sortNumeric', dedupe: 'dedupe',
    removeEmpty: 'removeEmpty', collapseEmpty: 'collapseEmpty', trimLeading: 'trimLeading',
    trimTrailing: 'trimTrailing', trimBoth: 'trimBoth', reverse: 'reverse', join: 'join',
};
const CASE_OPS: Partial<Record<TextToolId, CaseOp>> = { upper: 'upper', lower: 'lower', title: 'title' };
const CODEC_OPS: Partial<Record<TextToolId, CodecOp>> = {
    urlEncode: 'urlEncode', urlDecode: 'urlDecode', base64Encode: 'base64Encode', base64Decode: 'base64Decode',
    htmlEscape: 'htmlEscape', htmlUnescape: 'htmlUnescape', jsonEscape: 'jsonEscape', jsonUnescape: 'jsonUnescape',
};

const isReadOnly = (target: editor.IStandaloneCodeEditor) => target.getRawOptions().readOnly === true;

/** Non-empty selections, or the whole document when there are none. */
function targetRanges(target: editor.IStandaloneCodeEditor, model: editor.ITextModel): IRange[] {
    const selections = (target.getSelections() ?? []).filter(selection => !selection.isEmpty());
    return selections.length > 0 ? selections : [model.getFullModelRange()];
}

/** The full lines each selection touches (a selection ending at column 1 of a
 *  line doesn't include that line), merged where they overlap. */
function lineBlocks(target: editor.IStandaloneCodeEditor, model: editor.ITextModel): IRange[] {
    const selections = (target.getSelections() ?? []).filter(selection => !selection.isEmpty());
    if (selections.length === 0) {
        // The whole document, except the empty line after a final line
        // break: that is the file's last newline, not a line to sort, reverse
        // or count, and it stays at the end.
        let last = model.getLineCount();
        if (last > 1 && model.getLineContent(last) === '') last--;
        return [{ startLineNumber: 1, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) }];
    }
    const spans = selections
        .map(selection => {
            const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
                ? selection.endLineNumber - 1 : selection.endLineNumber;
            return [selection.startLineNumber, end] as [number, number];
        })
        .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
    }
    return merged.map(([first, last]) => ({ startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) }));
}

function linesOf(model: editor.ITextModel, range: IRange): string[] {
    const lines: string[] = [];
    for (let line = range.startLineNumber; line <= range.endLineNumber; line++) lines.push(model.getLineContent(line));
    return lines;
}

/** Replaces each range with its computed text as one undo step. Returns false
 *  (and says why) for a read-only document. */
function replaceAll(target: editor.IStandaloneCodeEditor, ranges: IRange[], compute: (text: string, range: IRange) => string, notify: ToolContext['notify']): boolean {
    if (isReadOnly(target)) {
        notify('warning', 'This document is read-only. Turn off read-only to change it.');
        return false;
    }
    const model = target.getModel()!;
    // Everything is computed first, so a failure part-way changes nothing.
    const edits = ranges.map(range => ({ range, text: compute(model.getValueInRange(range), range) }));
    const changed = edits.filter(edit => edit.text !== model.getValueInRange(edit.range));
    if (changed.length === 0) {
        notify('success', 'Nothing to change.');
        return true;
    }
    target.pushUndoStop();
    target.executeEdits('text-tools', changed.map(edit => ({ ...edit, forceMoveMarkers: true })));
    target.pushUndoStop();
    return true;
}

export async function runTextTool(id: TextToolId, context: ToolContext): Promise<void> {
    const { editor: target, notify } = context;
    const model = target?.getModel();
    if (!target || !model) {
        notify('warning', 'Open a document first.');
        return;
    }
    const eol = model.getEOL();
    const selectedOrAll = () => targetRanges(target, model).map(range => model.getValueInRange(range)).join(eol);
    try {
        const lineOp = LINE_OPS[id];
        if (lineOp) {
            replaceAll(target, lineBlocks(target, model), (_text, range) => transformLines(linesOf(model, range), lineOp).join(eol), notify);
            return;
        }
        const caseOp = CASE_OPS[id];
        if (caseOp) {
            replaceAll(target, targetRanges(target, model), text => changeCase(text, caseOp), notify);
            return;
        }
        const codecOp = CODEC_OPS[id];
        if (codecOp) {
            replaceAll(target, targetRanges(target, model), text => applyCodec(text, codecOp), notify);
            return;
        }
        switch (id) {
            case 'split': {
                const delimiter = context.input?.delimiter ?? '';
                replaceAll(target, lineBlocks(target, model), (_text, range) =>
                    splitLines(linesOf(model, range), delimiter, context.input?.trimPieces).join(eol), notify);
                return;
            }
            case 'countUnique': {
                const lines = lineBlocks(target, model).flatMap(range => linesOf(model, range));
                context.openInNewTab(formatLineCounts(countUniqueLines(lines), lines.length), 'plaintext');
                return;
            }
            case 'jwtDecode':
                context.openInNewTab(decodeJwt(selectedOrAll()), 'json');
                return;
            case 'uuid': {
                if (isReadOnly(target)) {
                    notify('warning', 'This document is read-only. Turn off read-only to change it.');
                    return;
                }
                const selections = target.getSelections() ?? [];
                target.pushUndoStop();
                target.executeEdits('text-tools', selections.map(range => ({ range, text: crypto.randomUUID(), forceMoveMarkers: true })));
                target.pushUndoStop();
                return;
            }
            case 'sha256':
            case 'md5': {
                const text = selectedOrAll();
                const digest = id === 'sha256' ? await sha256Hex(text) : md5Hex(text);
                await context.copyToClipboard(digest);
                notify('success', `${id === 'sha256' ? 'SHA-256' : 'MD5'} copied: ${digest}`);
                return;
            }
            case 'unixToDate':
            case 'dateToUnix': {
                const selections = (target.getSelections() ?? []).filter(selection => !selection.isEmpty());
                if (selections.length === 0) {
                    notify('warning', id === 'unixToDate' ? 'Select a Unix timestamp first.' : 'Select a date first.');
                    return;
                }
                replaceAll(target, selections, text => (id === 'unixToDate' ? unixToIso(text) : dateToUnix(text)), notify);
                return;
            }
            case 'csvToJson':
            case 'tsvToJson':
                context.openInNewTab(delimitedToJson(selectedOrAll(), id === 'csvToJson' ? ',' : '\t'), 'json');
                return;
            case 'jsonToCsv':
            case 'jsonToTsv':
                context.openInNewTab(jsonToDelimited(selectedOrAll(), id === 'jsonToCsv' ? ',' : '\t', eol), 'plaintext');
                return;
            case 'csvToTsv':
            case 'tsvToCsv':
                context.openInNewTab(
                    convertDelimited(selectedOrAll(), id === 'csvToTsv' ? ',' : '\t', id === 'csvToTsv' ? '\t' : ',', eol),
                    'plaintext');
                return;
            case 'xmlMinify':
                replaceAll(target, targetRanges(target, model), text => minifyXml(text), notify);
                return;
        }
    } catch (error) {
        notify('error', error instanceof Error ? error.message : String(error));
    }
}
