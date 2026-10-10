/**
 * Persistent marks: text the user wants to keep seeing while reading a log or
 * a config file. Each mark has its own colour, every occurrence stays
 * highlighted (in the text and the scrollbar) as the document changes, until
 * the mark is cleared.
 *
 * Marks belong to a document's model, so they show in every editor showing
 * it (both split panes, File Compare) and end with the document.
 */
import type { editor, IDisposable, IRange } from 'monaco-editor';
import { checkRegexSpeed, regexGuardAvailable } from './heavyTasks';

export const MARK_STYLE_COUNT = 6;
/** Occurrences highlighted per mark, from the top (bounded for huge files).
 *  Next/Previous Marked search the whole document regardless. */
export const MAX_MARKED_PER_MARK = 10_000;
/** A regular-expression mark runs again after every edit, on the main
 *  thread; it is first timed in a worker and turned off if it gets slow. */
const REGEX_MARK_LIMIT_MS = 300;
/** Monaco's default word separators (as the Find bar uses). */
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
const REFRESH_DELAY_MS = 200;

/** Overview-ruler colours of the six styles (the text colours are in styles.css). */
const RULER_COLORS = [
    'rgba(255, 196, 0, 0.9)', 'rgba(0, 170, 255, 0.9)', 'rgba(60, 200, 120, 0.9)',
    'rgba(230, 90, 200, 0.9)', 'rgba(255, 120, 40, 0.9)', 'rgba(150, 110, 255, 0.9)',
];

export interface MarkQuery {
    text: string;
    regex: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
}

export interface Mark extends MarkQuery {
    id: number;
    /** 0 … MARK_STYLE_COUNT - 1 */
    style: number;
    /** Occurrences found at the last refresh (capped at MAX_MARKED_PER_MARK). */
    count: number;
    /** More occurrences than are highlighted. */
    capped: boolean;
    /** A regular expression that became too slow on this document. */
    off: boolean;
}

interface Entry {
    marks: Mark[];
    decorationIds: string[];
    generation: number;
    timer: ReturnType<typeof setTimeout> | null;
    subscriptions: IDisposable[];
}

const entries = new Map<editor.ITextModel, Entry>();
const changeListeners = new Set<() => void>();
const problemListeners = new Set<(message: string) => void>();

/** Told when a mark is turned off (too slow on the document). */
export function onMarkProblem(listener: (message: string) => void): () => void {
    problemListeners.add(listener);
    return () => { problemListeners.delete(listener); };
}
let nextId = 1;

/** Called whenever any model's marks change (for menus and the palette). */
export function onMarksChanged(listener: () => void): () => void {
    changeListeners.add(listener);
    return () => { changeListeners.delete(listener); };
}

function notify() {
    changeListeners.forEach(listener => listener());
}

function entryFor(model: editor.ITextModel): Entry {
    let entry = entries.get(model);
    if (!entry) {
        const created: Entry = { marks: [], decorationIds: [], generation: 0, timer: null, subscriptions: [] };
        created.subscriptions.push(
            model.onDidChangeContent(() => {
                if (created.timer !== null) clearTimeout(created.timer);
                created.timer = setTimeout(() => { created.timer = null; void refresh(model); }, REFRESH_DELAY_MS);
            }),
            model.onWillDispose(() => forget(model)),
        );
        entries.set(model, created);
        entry = created;
    }
    return entry;
}

function forget(model: editor.ITextModel) {
    const entry = entries.get(model);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.subscriptions.forEach(subscription => subscription.dispose());
    entries.delete(model);
    notify();
}

function find(model: editor.ITextModel, mark: MarkQuery): editor.FindMatch[] {
    try {
        return model.findMatches(
            mark.text, false, mark.regex, mark.caseSensitive,
            mark.wholeWord ? WORD_SEPARATORS : null, false, MAX_MARKED_PER_MARK,
        );
    } catch {
        return []; // an invalid regular expression marks nothing
    }
}

/** Recomputes every occurrence of the model's marks. A regular expression
 *  is timed in a worker first; one that has become slow on the current text
 *  is turned off instead of being run on the main thread. */
export async function refresh(model: editor.ITextModel): Promise<void> {
    const entry = entries.get(model);
    if (!entry || model.isDisposed()) return;
    const generation = ++entry.generation;
    const regexMarks = entry.marks.filter(mark => mark.regex && !mark.off);
    if (regexMarks.length > 0 && regexGuardAvailable()) {
        const text = model.getValue();
        for (const mark of regexMarks) {
            // Over the whole text: Next/Previous Marked search all of it.
            const speed = await checkRegexSpeed(mark.text, mark.caseSensitive ? 'gmu' : 'gimu', text, REGEX_MARK_LIMIT_MS, true);
            if (generation !== entry.generation || model.isDisposed()) return; // a newer refresh runs
            if (speed === 'slow') {
                mark.off = true;
                problemListeners.forEach(listener => listener(`The mark /${mark.text}/ was turned off: it takes too long on this document.`));
            }
        }
    }
    const decorations: editor.IModelDeltaDecoration[] = [];
    for (const mark of entry.marks) {
        const found = mark.off ? [] : find(model, mark);
        mark.count = found.length;
        mark.capped = found.length >= MAX_MARKED_PER_MARK;
        for (const match of found) {
            decorations.push({
                range: match.range,
                options: {
                    inlineClassName: `zitext-mark zitext-mark-${mark.style + 1}`,
                    overviewRuler: { color: RULER_COLORS[mark.style], position: 4 /* OverviewRulerLane.Center */ },
                    stickiness: 1, // NeverGrowsWhenTypingAtEdges
                },
            });
        }
    }
    entry.decorationIds = model.deltaDecorations(entry.decorationIds, decorations);
    notify();
}

const sameQuery = (a: MarkQuery, b: MarkQuery) =>
    a.text === b.text && a.regex === b.regex && a.caseSensitive === b.caseSensitive && a.wholeWord === b.wholeWord;

/**
 * Marks every occurrence of `query` in the next free colour (they cycle when
 * all six are in use). Marking the same thing twice returns the existing mark.
 */
/** Why a query can't be a mark, or null. A pattern that matches empty text
 *  (\d*, (err)?) would mark nothing visible and keep F4 in one place. */
export function markProblem(query: MarkQuery): string | null {
    if (!query.text) return 'Enter the text to mark.';
    if (!query.regex) return null;
    try {
        if (new RegExp(query.text, 'u').test('')) return 'This pattern can match empty text. Use one that always matches at least one character.';
    } catch (error) {
        return `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
    }
    return null;
}

/** Refuses a query markProblem() rejects (throws its message). */
export async function addMark(model: editor.ITextModel, query: MarkQuery): Promise<Mark> {
    const problem = markProblem(query);
    if (problem) throw new Error(problem);
    const entry = entryFor(model);
    const existing = entry.marks.find(mark => sameQuery(mark, query));
    if (existing) return existing;
    const used = new Set(entry.marks.map(mark => mark.style));
    let style = 0;
    while (used.has(style) && style < MARK_STYLE_COUNT) style++;
    if (style === MARK_STYLE_COUNT) style = entry.marks.length % MARK_STYLE_COUNT;
    const mark: Mark = { ...query, id: nextId++, style, count: 0, capped: false, off: false };
    entry.marks.push(mark);
    await refresh(model);
    return mark;
}

export function marksOf(model: editor.ITextModel | null | undefined): Mark[] {
    return model ? [...(entries.get(model)?.marks ?? [])] : [];
}

export function removeMark(model: editor.ITextModel, id: number): void {
    const entry = entries.get(model);
    if (!entry) return;
    entry.marks = entry.marks.filter(mark => mark.id !== id);
    void refresh(model);
}

export function clearMarks(model: editor.ITextModel): void {
    const entry = entries.get(model);
    if (!entry) return;
    entry.marks = [];
    void refresh(model);
}

/** The highlighted ranges in document order. */
export function markedRanges(model: editor.ITextModel): IRange[] {
    const entry = entries.get(model);
    if (!entry) return [];
    return entry.decorationIds
        .map(id => model.getDecorationRange(id))
        .filter((range): range is NonNullable<typeof range> => range !== null)
        .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
}

/**
 * The nearest marked occurrence after `position` (or, backwards, before it),
 * wrapping around. Searches the whole document, so occurrences past the
 * highlighted ones are reached too. Going backwards, pass the start of the
 * current selection; going forwards, its end.
 */
export function nextMarked(
    model: editor.ITextModel,
    position: { lineNumber: number; column: number },
    backwards: boolean,
): IRange | null {
    const marks = (entries.get(model)?.marks ?? []).filter(mark => !mark.off);
    if (marks.length === 0) return null;
    const length = Math.max(1, model.getValueLength());
    const from = model.getOffsetAt(position);
    let best: { range: IRange; distance: number } | null = null;
    for (const mark of marks) {
        let match: editor.FindMatch | null = null;
        try {
            match = backwards
                ? model.findPreviousMatch(mark.text, position, mark.regex, mark.caseSensitive, mark.wholeWord ? WORD_SEPARATORS : null, false)
                : model.findNextMatch(mark.text, position, mark.regex, mark.caseSensitive, mark.wholeWord ? WORD_SEPARATORS : null, false);
        } catch {
            match = null;
        }
        if (!match || (match.range.startLineNumber === match.range.endLineNumber && match.range.startColumn === match.range.endColumn)) continue;
        const at = model.getOffsetAt({ lineNumber: match.range.startLineNumber, column: match.range.startColumn });
        const raw = backwards ? from - at : at - from;
        // At distance 0 (backwards: the occurrence starting right here) the
        // nearest is the whole way round.
        const distance = backwards ? (raw > 0 ? raw : raw + length) : (raw >= 0 ? raw : raw + length);
        if (!best || distance < best.distance) best = { range: match.range, distance };
    }
    return best?.range ?? null;
}

/** What the Find bar is looking for, so "Mark Find Matches" can mark it. */
let lastFind: MarkQuery | null = null;
export function setLastFindQuery(query: MarkQuery | null): void {
    lastFind = query && query.text ? query : null;
}
export function lastFindQuery(): MarkQuery | null {
    return lastFind;
}
