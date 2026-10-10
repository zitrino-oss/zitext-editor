/**
 * Line and character differences between two documents, for the compare
 * view. Pure functions over arrays of lines (no line terminators, as Monaco's
 * model.getLinesContent() returns them), so the work can run in a background
 * worker and be tested without an editor.
 *
 * Lines are matched in three passes, cheapest first: the common start and end
 * are taken off, lines that occur exactly once on each side anchor the rest
 * (patience diff), and whatever has no such anchors goes to Myers' O(ND)
 * algorithm. Myers is capped, so two unrelated large files report one big
 * modified block instead of freezing the window.
 */

export interface DiffOptions {
    /** Leading/trailing whitespace doesn't make lines differ. */
    ignoreTrimWhitespace: boolean;
    /** Any whitespace difference is ignored ("a b" equals "ab"). */
    ignoreAllWhitespace: boolean;
    ignoreCase: boolean;
    /** Added or removed blank (whitespace-only) lines are not changes. */
    ignoreBlankLines: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = Object.freeze({
    ignoreTrimWhitespace: false,
    ignoreAllWhitespace: false,
    ignoreCase: false,
    ignoreBlankLines: false,
});

/** Columns are 1-based, Monaco-style; endColumn is exclusive. */
export interface CharRange { startColumn: number; endColumn: number }

/** Character differences for one pair of lines inside a modified region. */
export interface LinePairDiff { leftLine: number; rightLine: number; left: CharRange[]; right: CharRange[] }

export interface DiffRegion {
    /** 1-based first line on each side. When a side's count is 0 the region sits
     *  just before that line (so after line start - 1; start may be lineCount + 1). */
    leftStart: number;
    leftCount: number;
    rightStart: number;
    rightCount: number;
    /** added: leftCount 0; removed: rightCount 0. */
    kind: 'added' | 'removed' | 'modified';
    /** Lines differ only in ways the options ignore (e.g. only blank lines with
     *  ignoreBlankLines). Used to keep the two sides aligned; not shown as a change. */
    ignored: boolean;
    /** For modified, non-ignored regions: lines paired in order (min of the two counts),
     *  with character ranges. Empty for added/removed/ignored regions. */
    lines: LinePairDiff[];
}

export interface DiffResult {
    /** Every non-matching region in order, including ignored ones. */
    regions: DiffRegion[];
    /** Number of non-ignored regions. */
    changeCount: number;
    /** True if part of the input exceeded the exact-diff budget and was reported as one modified block. */
    approximate: boolean;
}

/** The edit that copies a region's lines from one side to the other (merge action),
 *  expressed against the TARGET document's lines. Monaco-style 1-based range. */
export interface MergeEdit { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; text: string }

/**
 * Myers gives up past this many inserted plus deleted lines in one stretch
 * without anchors. Its saved search history grows with the square of this, so
 * it also bounds memory (about 8 MB at the cap).
 */
const MAX_LINE_EDIT_DISTANCE = 2000;
/** Total steps the line matching may take before the rest is reported as blocks. */
const LINE_WORK_BUDGET = 40_000_000;
/** Longer lines get one whole-line highlight instead of a character diff. */
const MAX_CHAR_DIFF_LINE_LENGTH = 2000;
const MAX_CHAR_EDIT_DISTANCE = 500;
/** Total character-diff steps for one comparison; later pairs get one block per side. */
const CHAR_WORK_BUDGET = 20_000_000;
/** Changes this close together are shown as one highlight rather than confetti. */
const MERGE_GAP = 2;

interface Budget { remaining: number }

/** The text two lines are compared by, with the ignored differences removed. */
function lineKey(line: string, options: DiffOptions): string {
    const key = options.ignoreAllWhitespace ? line.replace(/\s+/g, '')
        : options.ignoreTrimWhitespace ? line.trim() : line;
    return options.ignoreCase ? key.toLowerCase() : key;
}

function isBlank(line: string): boolean {
    return line.trim() === '';
}

/**
 * Myers' greedy O(ND) diff of a[aLo, aHi) against b[bLo, bHi), reporting each
 * matched pair through `match` (in reverse order). Returns false, matching
 * nothing, when the edit distance passes maxD or the shared budget runs out;
 * the caller then treats the whole stretch as changed.
 */
function myers(
    a: Int32Array, aLo: number, aHi: number,
    b: Int32Array, bLo: number, bHi: number,
    maxD: number, budget: Budget, match: (i: number, j: number) => void,
): boolean {
    const n = aHi - aLo;
    const m = bHi - bLo;
    const max = Math.min(n + m, maxD);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d] holds v[k] for k = -d..d step 2 after step d, for walking back.
    const trace: Int32Array[] = [];
    let work = 0;
    for (let d = 0; d <= max; d++) {
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
                ? v[offset + k + 1]
                : v[offset + k - 1] + 1;
            let y = x - k;
            const startX = x;
            while (x < n && y < m && a[aLo + x] === b[bLo + y]) { x++; y++; }
            work += 1 + x - startX;
            v[offset + k] = x;
            if (x >= n && y >= m) {
                budget.remaining -= work;
                backtrack(trace, d, n, m, (i, j) => match(aLo + i, bLo + j));
                return true;
            }
        }
        const snapshot = new Int32Array(d + 1);
        for (let k = -d; k <= d; k += 2) snapshot[(k + d) >> 1] = v[offset + k];
        trace.push(snapshot);
        if (work > budget.remaining) {
            budget.remaining = 0;
            return false;
        }
    }
    budget.remaining -= work;
    return false;
}

/** Walks Myers' saved steps back from (n, m), reporting the diagonal (matched) moves. */
function backtrack(trace: Int32Array[], d: number, n: number, m: number, match: (i: number, j: number) => void): void {
    let x = n;
    let y = m;
    for (let step = d; step > 0; step--) {
        const prev = trace[step - 1];
        const at = (k: number) => prev[(k + step - 1) >> 1];
        const k = x - y;
        const down = k === -step || (k !== step && at(k - 1) < at(k + 1));
        const prevK = down ? k + 1 : k - 1;
        const prevX = at(prevK);
        const snakeStart = down ? prevX : prevX + 1;
        for (let sx = x - 1; sx >= snakeStart; sx--) match(sx, sx - k);
        x = prevX;
        y = prevX - prevK;
    }
    for (let sx = x - 1; sx >= 0; sx--) match(sx, sx);
}

/**
 * Lines that occur exactly once in a[aLo, aHi) and once in b[bLo, bHi), kept
 * in an order that increases on both sides (longest increasing subsequence).
 * Returned as flat [i, j, i, j, ...] pairs.
 */
function uniqueAnchors(
    a: Int32Array, aLo: number, aHi: number,
    b: Int32Array, bLo: number, bHi: number,
    countA: Int32Array, countB: Int32Array, posB: Int32Array,
): number[] {
    for (let i = aLo; i < aHi; i++) countA[a[i]]++;
    for (let j = bLo; j < bHi; j++) { countB[b[j]]++; posB[b[j]] = j; }
    const candA: number[] = [];
    const candB: number[] = [];
    for (let i = aLo; i < aHi; i++) {
        const id = a[i];
        if (countA[id] === 1 && countB[id] === 1) { candA.push(i); candB.push(posB[id]); }
    }
    for (let i = aLo; i < aHi; i++) countA[a[i]] = 0;
    for (let j = bLo; j < bHi; j++) countB[b[j]] = 0;
    if (candA.length === 0) return [];

    // Patience sorting: tails[len] is the candidate ending the best run of len + 1.
    const tails: number[] = [];
    const prev = new Int32Array(candA.length);
    for (let c = 0; c < candA.length; c++) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (candB[tails[mid]] < candB[c]) lo = mid + 1; else hi = mid;
        }
        prev[c] = lo > 0 ? tails[lo - 1] : -1;
        tails[lo] = c;
    }
    const chain: number[] = new Array<number>(tails.length * 2);
    for (let c = tails[tails.length - 1], at = tails.length - 1; c >= 0; c = prev[c], at--) {
        chain[at * 2] = candA[c];
        chain[at * 2 + 1] = candB[c];
    }
    return chain;
}

interface LineMatch { aToB: Int32Array; approximate: boolean }

/** Matches the id sequences a and b; aToB[i] is the matching index in b, or -1. */
function matchLines(a: Int32Array, b: Int32Array, idCount: number): LineMatch {
    const aToB = new Int32Array(a.length).fill(-1);
    const countA = new Int32Array(idCount);
    const countB = new Int32Array(idCount);
    const posB = new Int32Array(idCount);
    const budget: Budget = { remaining: LINE_WORK_BUDGET };
    const record = (i: number, j: number) => { aToB[i] = j; };
    let approximate = false;
    // An explicit stack rather than recursion: nested anchor passes can go deep.
    const stack: number[] = [0, a.length, 0, b.length];
    while (stack.length > 0) {
        let bHi = stack.pop()!;
        let bLo = stack.pop()!;
        let aHi = stack.pop()!;
        let aLo = stack.pop()!;
        while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) aToB[aLo++] = bLo++;
        while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) aToB[--aHi] = --bHi;
        if (aLo === aHi || bLo === bHi) continue;

        budget.remaining -= 3 * (aHi - aLo + bHi - bLo);
        if (budget.remaining <= 0) {
            budget.remaining = 0;
            approximate = true;
            continue;
        }
        const anchors = uniqueAnchors(a, aLo, aHi, b, bLo, bHi, countA, countB, posB);
        if (anchors.length > 0) {
            let pa = aLo;
            let pb = bLo;
            for (let c = 0; c < anchors.length; c += 2) {
                const i = anchors[c];
                const j = anchors[c + 1];
                aToB[i] = j;
                if (i > pa && j > pb) stack.push(pa, i, pb, j);
                pa = i + 1;
                pb = j + 1;
            }
            if (aHi > pa && bHi > pb) stack.push(pa, aHi, pb, bHi);
        } else if (!myers(a, aLo, aHi, b, bLo, bHi, MAX_LINE_EDIT_DISTANCE, budget, record)) {
            approximate = true;
        }
    }
    return { aToB, approximate };
}

function isWhitespaceCode(code: number): boolean {
    if (code === 32 || (code >= 9 && code <= 13) || code === 160) return true;
    return code > 127 && /\s/.test(String.fromCharCode(code));
}

function lowerCode(code: number): number {
    if (code >= 65 && code <= 90) return code + 32;
    if (code < 128) return code;
    const lower = String.fromCharCode(code).toLowerCase();
    return lower.length === 1 ? lower.charCodeAt(0) : code;
}

/**
 * The characters of a line that take part in the comparison, with the column
 * each came from, so ranges found on the normalized text map back onto the
 * original one. Ignored whitespace is left out rather than rewritten.
 */
function charSequence(line: string, options: DiffOptions): { codes: Int32Array; cols: Int32Array } {
    let start = 0;
    let end = line.length;
    if (options.ignoreTrimWhitespace && !options.ignoreAllWhitespace) {
        while (start < end && isWhitespaceCode(line.charCodeAt(start))) start++;
        while (end > start && isWhitespaceCode(line.charCodeAt(end - 1))) end--;
    }
    const codes = new Int32Array(end - start);
    const cols = new Int32Array(end - start);
    let length = 0;
    for (let col = start; col < end; col++) {
        const code = line.charCodeAt(col);
        if (options.ignoreAllWhitespace && isWhitespaceCode(code)) continue;
        codes[length] = options.ignoreCase ? lowerCode(code) : code;
        cols[length++] = col;
    }
    return { codes: codes.subarray(0, length), cols: cols.subarray(0, length) };
}

function wholeLine(line: string): CharRange[] {
    return line.length > 0 ? [{ startColumn: 1, endColumn: line.length + 1 }] : [];
}

/** Character ranges that differ between two lines already known to differ. */
function diffLinePair(leftText: string, rightText: string, options: DiffOptions, budget: Budget): { left: CharRange[]; right: CharRange[] } {
    if (leftText.length > MAX_CHAR_DIFF_LINE_LENGTH || rightText.length > MAX_CHAR_DIFF_LINE_LENGTH) {
        return { left: wholeLine(leftText), right: wholeLine(rightText) };
    }
    const a = charSequence(leftText, options);
    const b = charSequence(rightText, options);
    const n = a.codes.length;
    const m = b.codes.length;
    const aToB = new Int32Array(n).fill(-1);
    let lo = 0;
    let aHi = n;
    let bHi = m;
    while (lo < aHi && lo < bHi && a.codes[lo] === b.codes[lo]) { aToB[lo] = lo; lo++; }
    while (aHi > lo && bHi > lo && a.codes[aHi - 1] === b.codes[bHi - 1]) aToB[--aHi] = --bHi;
    if (aHi > lo && bHi > lo) {
        myers(a.codes, lo, aHi, b.codes, lo, bHi, MAX_CHAR_EDIT_DISTANCE, budget, (i, j) => { aToB[i] = j; });
    }

    // Unmatched stretches between matches, as [aStart, aEnd, bStart, bEnd] quads.
    const hunks: number[] = [];
    let pi = 0;
    let pj = 0;
    for (let i = 0; i <= n; i++) {
        const j = i < n ? aToB[i] : m;
        if (j < 0) continue;
        if (i > pi || j > pj) {
            const last = hunks.length - 4;
            if (last >= 0 && pi - hunks[last + 1] <= MERGE_GAP) {
                hunks[last + 1] = i;
                hunks[last + 3] = j;
            } else {
                hunks.push(pi, i, pj, j);
            }
        }
        pi = i + 1;
        pj = j + 1;
    }

    const left: CharRange[] = [];
    const right: CharRange[] = [];
    for (let h = 0; h < hunks.length; h += 4) {
        if (hunks[h + 1] > hunks[h]) left.push({ startColumn: a.cols[hunks[h]] + 1, endColumn: a.cols[hunks[h + 1] - 1] + 2 });
        if (hunks[h + 3] > hunks[h + 2]) right.push({ startColumn: b.cols[hunks[h + 2]] + 1, endColumn: b.cols[hunks[h + 3] - 1] + 2 });
    }
    return { left, right };
}

export function computeDiff(left: string[], right: string[], options: DiffOptions): DiffResult {
    const ids = new Map<string, number>();
    const toIds = (lines: string[]) => {
        const out = new Int32Array(lines.length);
        for (let i = 0; i < lines.length; i++) {
            const key = lineKey(lines[i], options);
            let id = ids.get(key);
            if (id === undefined) { id = ids.size; ids.set(key, id); }
            out[i] = id;
        }
        return out;
    };
    const leftIds = toIds(left);
    const rightIds = toIds(right);

    // With ignoreBlankLines, blank lines take no part in matching; they end up
    // in the gaps between matched lines and are sorted out there.
    const matchable = (lines: string[], lineIds: Int32Array) => {
        if (!options.ignoreBlankLines) return { seq: lineIds, index: null };
        const index: number[] = [];
        for (let i = 0; i < lines.length; i++) if (!isBlank(lines[i])) index.push(i);
        return { seq: Int32Array.from(index, i => lineIds[i]), index };
    };
    const a = matchable(left, leftIds);
    const b = matchable(right, rightIds);
    const { aToB, approximate } = matchLines(a.seq, b.seq, ids.size);

    const regions: DiffRegion[] = [];
    const charBudget: Budget = { remaining: CHAR_WORK_BUDGET };
    const addGap = (la: number, lb: number, ra: number, rb: number) => {
        // Equal edges (blank lines, or lines the matching gave up on) still pair up.
        while (la < lb && ra < rb && leftIds[la] === rightIds[ra]) { la++; ra++; }
        while (la < lb && ra < rb && leftIds[lb - 1] === rightIds[rb - 1]) { lb--; rb--; }
        if (la === lb && ra === rb) return;
        let ignored = options.ignoreBlankLines;
        for (let i = la; ignored && i < lb; i++) ignored = isBlank(left[i]);
        for (let j = ra; ignored && j < rb; j++) ignored = isBlank(right[j]);
        const leftCount = lb - la;
        const rightCount = rb - ra;
        const kind = leftCount === 0 ? 'added' : rightCount === 0 ? 'removed' : 'modified';
        const lines: LinePairDiff[] = [];
        if (kind === 'modified' && !ignored) {
            for (let p = 0; p < Math.min(leftCount, rightCount); p++) {
                const i = la + p;
                const j = ra + p;
                const ranges = leftIds[i] === rightIds[j]
                    ? { left: [], right: [] }
                    : diffLinePair(left[i], right[j], options, charBudget);
                lines.push({ leftLine: i + 1, rightLine: j + 1, left: ranges.left, right: ranges.right });
            }
        }
        regions.push({ leftStart: la + 1, leftCount, rightStart: ra + 1, rightCount, kind, ignored, lines });
    };

    let pa = 0;
    let pb = 0;
    for (let i = 0; i < aToB.length; i++) {
        if (aToB[i] < 0) continue;
        const la = a.index ? a.index[i] : i;
        const rb = b.index ? b.index[aToB[i]] : aToB[i];
        addGap(pa, la, pb, rb);
        pa = la + 1;
        pb = rb + 1;
    }
    addGap(pa, left.length, pb, right.length);

    return {
        regions,
        changeCount: regions.reduce((count, region) => count + (region.ignored ? 0 : 1), 0),
        approximate,
    };
}

/**
 * The edit that makes the target side's lines for `region` equal the source
 * side's. Whole lines are replaced where both sides have some; otherwise a
 * line terminator is added or removed along with the lines, taking it from
 * before the region at the end of the document, where the last line has none.
 * `eol` is the target document's line ending, used when lines are inserted.
 */
export function mergeEdit(region: DiffRegion, from: 'left' | 'right', left: string[], right: string[], eol: string): MergeEdit {
    const source = from === 'left' ? left : right;
    const target = from === 'left' ? right : left;
    const sourceStart = from === 'left' ? region.leftStart : region.rightStart;
    const sourceCount = from === 'left' ? region.leftCount : region.rightCount;
    const targetStart = from === 'left' ? region.rightStart : region.leftStart;
    const targetCount = from === 'left' ? region.rightCount : region.leftCount;
    const text = source.slice(sourceStart - 1, sourceStart - 1 + sourceCount).join(eol);
    const lastLine = target.length;
    const endOf = (line: number) => target[line - 1].length + 1;
    const edit = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number, newText: string): MergeEdit =>
        ({ startLineNumber, startColumn, endLineNumber, endColumn, text: newText });

    if (targetCount > 0) {
        const endLine = targetStart + targetCount - 1;
        if (sourceCount > 0) return edit(targetStart, 1, endLine, endOf(endLine), text);
        if (endLine < lastLine) return edit(targetStart, 1, endLine + 1, 1, '');
        if (targetStart > 1) return edit(targetStart - 1, endOf(targetStart - 1), endLine, endOf(endLine), '');
        return edit(1, 1, endLine, endOf(endLine), ''); // every line: the document empties
    }
    if (targetStart <= lastLine) {
        return edit(targetStart, 1, targetStart, 1, sourceCount > 0 ? text + eol : '');
    }
    return edit(lastLine, endOf(lastLine), lastLine, endOf(lastLine), sourceCount > 0 ? eol + text : '');
}
