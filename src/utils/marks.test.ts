/**
 * Persistent marks: colours, every occurrence kept highlighted as the text
 * changes, next/previous, clearing, and cleanup when the document closes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { editor } from 'monaco-editor';

const speed = vi.hoisted(() => ({ verdict: 'ok' as 'ok' | 'slow' }));
vi.mock('./heavyTasks', () => ({
    regexGuardAvailable: () => true,
    checkRegexSpeed: vi.fn(async () => speed.verdict),
}));

import {
    addMark, clearMarks, lastFindQuery, MARK_STYLE_COUNT, MAX_MARKED_PER_MARK, marksOf, nextMarked, onMarkProblem,
    onMarksChanged, removeMark, setLastFindQuery,
} from './marks';

interface Range { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

function fakeModel(text: string) {
    let lines = text.split('\n');
    const changeListeners = new Set<() => void>();
    const disposeListeners = new Set<() => void>();
    const decorations = new Map<string, { range: Range; options: { inlineClassName: string } }>();
    let nextId = 1;
    let disposed = false;
    const model = {
        findMatches(search: string, _editable: boolean, isRegex: boolean, matchCase: boolean, separators: string | null, _captures: boolean, limit: number) {
            const source = isRegex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(separators !== null ? `(?<![\\w])${source}(?![\\w])` : source, matchCase ? 'g' : 'gi');
            const found: { range: Range }[] = [];
            lines.forEach((line, index) => {
                for (const match of line.matchAll(regex)) {
                    if (found.length >= limit) return;
                    found.push({ range: { startLineNumber: index + 1, startColumn: match.index! + 1, endLineNumber: index + 1, endColumn: match.index! + 1 + match[0].length } });
                }
            });
            return found;
        },
        deltaDecorations(old: string[], added: { range: Range; options: { inlineClassName: string } }[]) {
            old.forEach(id => decorations.delete(id));
            return added.map(decoration => {
                const id = String(nextId++);
                decorations.set(id, decoration);
                return id;
            });
        },
        getDecorationRange: (id: string) => decorations.get(id)?.range ?? null,
        getValue: () => lines.join('\n'),
        getValueLength: () => lines.join('\n').length,
        getOffsetAt: (p: { lineNumber: number; column: number }) => lines.slice(0, p.lineNumber - 1).reduce((sum, l) => sum + l.length + 1, 0) + p.column - 1,
        findNextMatch(search: string, from: { lineNumber: number; column: number }, isRegex: boolean, matchCase: boolean, separators: string | null) {
            const all = model.findMatches(search, false, isRegex, matchCase, separators, false, Infinity);
            const at = model.getOffsetAt(from);
            return all.find(m => model.getOffsetAt({ lineNumber: m.range.startLineNumber, column: m.range.startColumn }) >= at) ?? all[0] ?? null;
        },
        findPreviousMatch(search: string, from: { lineNumber: number; column: number }, isRegex: boolean, matchCase: boolean, separators: string | null) {
            const all = model.findMatches(search, false, isRegex, matchCase, separators, false, Infinity);
            const at = model.getOffsetAt(from);
            return [...all].reverse().find(m => model.getOffsetAt({ lineNumber: m.range.startLineNumber, column: m.range.startColumn }) < at) ?? all[all.length - 1] ?? null;
        },
        onDidChangeContent: (listener: () => void) => { changeListeners.add(listener); return { dispose: () => changeListeners.delete(listener) }; },
        onWillDispose: (listener: () => void) => { disposeListeners.add(listener); return { dispose: () => disposeListeners.delete(listener) }; },
        isDisposed: () => disposed,
    };
    return {
        model: model as unknown as editor.ITextModel,
        decorations,
        setText(next: string) { lines = next.split('\n'); changeListeners.forEach(listener => listener()); },
        dispose() { disposeListeners.forEach(listener => listener()); disposed = true; },
        classesAt: () => [...decorations.values()].map(d => d.options.inlineClassName),
    };
}

const query = (text: string, extra: Partial<{ regex: boolean; caseSensitive: boolean; wholeWord: boolean }> = {}) =>
    ({ text, regex: false, caseSensitive: true, wholeWord: false, ...extra });

afterEach(() => { vi.useRealTimers(); });

describe('marks', () => {
    it('highlight every occurrence, each mark in its own colour', async () => {
        const fake = fakeModel('ERROR one\ntimeout ERROR\nok');
        const error = await addMark(fake.model, query('ERROR'));
        const timeout = await addMark(fake.model, query('timeout'));
        expect([error.style, timeout.style]).toEqual([0, 1]);
        expect(error.count).toBe(2);
        expect(fake.classesAt().sort()).toEqual(['zitext-mark zitext-mark-1', 'zitext-mark zitext-mark-1', 'zitext-mark zitext-mark-2']);
        // The same mark twice is one mark.
        expect(await addMark(fake.model, query('ERROR'))).toBe(error);
        expect(marksOf(fake.model)).toHaveLength(2);
    });

    it('cycle through the colours and reuse a freed one', async () => {
        const fake = fakeModel('a b c d e f g h');
        const marks = [];
        for (const letter of 'abcdefg') marks.push(await addMark(fake.model, query(letter)));
        expect(marks.map(mark => mark.style)).toEqual([0, 1, 2, 3, 4, 5, 6 % MARK_STYLE_COUNT]);
        removeMark(fake.model, marks[2].id);
        expect((await addMark(fake.model, query('h'))).style).toBe(2);
    });

    it('follow the text as it changes', async () => {
        vi.useFakeTimers();
        const fake = fakeModel('nothing yet');
        const mark = await addMark(fake.model, query('id=7'));
        expect(mark.count).toBe(0);
        fake.setText('id=7 and id=7');
        await vi.advanceTimersByTimeAsync(250);
        expect(marksOf(fake.model)[0].count).toBe(2);
        expect(fake.decorations.size).toBe(2);
    });

    it('honour case, whole word and regular expressions', async () => {
        const fake = fakeModel('Timeout timeout timeouts customer_id=12 customer_id=345');
        expect((await addMark(fake.model, query('timeout', { caseSensitive: false }))).count).toBe(3);
        clearMarks(fake.model);
        expect((await addMark(fake.model, query('timeout', { caseSensitive: false, wholeWord: true }))).count).toBe(2);
        expect((await addMark(fake.model, query('customer_id=\\d+', { regex: true }))).count).toBe(2);
        // Invalid patterns, and ones that can match empty text (F4 couldn't
        // move past them), are refused with a reason.
        await expect(addMark(fake.model, query('(', { regex: true }))).rejects.toThrow('Invalid regular expression');
        await expect(addMark(fake.model, query('\\d*', { regex: true }))).rejects.toThrow('can match empty text');
        await expect(addMark(fake.model, query('customer\\_id', { regex: true }))).rejects.toThrow('Invalid regular expression');
    });

    it('go to the next and previous marked text, wrapping around', async () => {
        const fake = fakeModel('x A\nA y\nz A');
        await addMark(fake.model, query('A'));
        // Forward from the end of the current occurrence, back from its start.
        expect(nextMarked(fake.model, { lineNumber: 1, column: 1 }, false)).toMatchObject({ startLineNumber: 1, startColumn: 3 });
        expect(nextMarked(fake.model, { lineNumber: 1, column: 4 }, false)).toMatchObject({ startLineNumber: 2, startColumn: 1 });
        expect(nextMarked(fake.model, { lineNumber: 3, column: 4 }, false)).toMatchObject({ startLineNumber: 1, startColumn: 3 });
        expect(nextMarked(fake.model, { lineNumber: 2, column: 1 }, true)).toMatchObject({ startLineNumber: 1, startColumn: 3 });
        expect(nextMarked(fake.model, { lineNumber: 1, column: 1 }, true)).toMatchObject({ startLineNumber: 3, startColumn: 3 });
    });

    it('clear one or all, and end with the document', async () => {
        const fake = fakeModel('a b');
        const listener = vi.fn();
        const stop = onMarksChanged(listener);
        const a = await addMark(fake.model, query('a'));
        await addMark(fake.model, query('b'));
        removeMark(fake.model, a.id);
        expect(marksOf(fake.model).map(mark => mark.text)).toEqual(['b']);
        clearMarks(fake.model);
        expect(fake.decorations.size).toBe(0);
        await addMark(fake.model, query('a'));
        fake.dispose();
        expect(marksOf(fake.model)).toEqual([]);
        expect(listener).toHaveBeenCalled();
        stop();
    });

    it('go back past the occurrence that is selected, not stick on it', async () => {
        const fake = fakeModel('a\nx X\nb\nc\nX y\nz');
        await addMark(fake.model, query('X'));
        // On "X" at 5:3 (selected), going back from its start finds 2:3.
        expect(nextMarked(fake.model, { lineNumber: 5, column: 1 }, true)).toMatchObject({ startLineNumber: 2, startColumn: 3 });
        expect(nextMarked(fake.model, { lineNumber: 2, column: 3 }, true)).toMatchObject({ startLineNumber: 5, startColumn: 1 });
    });

    it('reach occurrences past the highlighted ones', async () => {
        const fake = fakeModel(Array.from({ length: MAX_MARKED_PER_MARK + 5 }, (_, i) => `INFO ${i}`).join('\n'));
        const mark = await addMark(fake.model, query('INFO'));
        expect(mark.capped).toBe(true);
        expect(nextMarked(fake.model, { lineNumber: MAX_MARKED_PER_MARK + 2, column: 2 }, false))
            .toMatchObject({ startLineNumber: MAX_MARKED_PER_MARK + 3 });
    });

    it('turn a regular expression off when it gets too slow on the text', async () => {
        vi.useFakeTimers();
        const problems: string[] = [];
        const stop = onMarkProblem(message => problems.push(message));
        const fake = fakeModel('aaa');
        const mark = await addMark(fake.model, query('(a+)+$', { regex: true }));
        expect(mark.count).toBe(1);
        speed.verdict = 'slow';
        fake.setText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!');
        await vi.advanceTimersByTimeAsync(250);
        expect(marksOf(fake.model)[0]).toMatchObject({ off: true, count: 0 });
        expect(fake.decorations.size).toBe(0);
        expect(problems[0]).toContain('turned off');
        speed.verdict = 'ok';
        stop();
    });

    it('remember what Find searched for', () => {
        setLastFindQuery({ text: 'x', regex: false, caseSensitive: false, wholeWord: false });
        expect(lastFindQuery()?.text).toBe('x');
        setLastFindQuery({ text: '', regex: false, caseSensitive: false, wholeWord: false });
        expect(lastFindQuery()).toBeNull();
    });
});
