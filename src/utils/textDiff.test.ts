/** Line and character diff for the compare view, and the merge edits built from it. */
import { describe, expect, it } from 'vitest';
import {
    computeDiff, mergeEdit, DEFAULT_DIFF_OPTIONS,
    type DiffOptions, type DiffRegion, type DiffResult, type MergeEdit,
} from './textDiff';
import { runHeavyTask } from './heavyTaskRunner';

const opts = (overrides: Partial<DiffOptions> = {}): DiffOptions => ({ ...DEFAULT_DIFF_OPTIONS, ...overrides });

/** Applies a Monaco-style edit to a document held as lines joined by `eol`. */
function applyEdit(lines: string[], edit: MergeEdit, eol: string): string[] {
    const offset = (line: number, column: number) => {
        let at = 0;
        for (let i = 0; i < line - 1; i++) at += lines[i].length + eol.length;
        return at + column - 1;
    };
    const text = lines.join(eol);
    const start = offset(edit.startLineNumber, edit.startColumn);
    const end = offset(edit.endLineNumber, edit.endColumn);
    expect(start).toBeLessThanOrEqual(end);
    expect(end).toBeLessThanOrEqual(text.length);
    return (text.slice(0, start) + edit.text + text.slice(end)).split(eol);
}

/** The target document with the region's lines replaced by the source's. */
function expectedMerge(region: DiffRegion, from: 'left' | 'right', left: string[], right: string[]): string[] {
    const [source, target] = from === 'left' ? [left, right] : [right, left];
    const [sStart, sCount, tStart, tCount] = from === 'left'
        ? [region.leftStart, region.leftCount, region.rightStart, region.rightCount]
        : [region.rightStart, region.rightCount, region.leftStart, region.leftCount];
    const result = [
        ...target.slice(0, tStart - 1),
        ...source.slice(sStart - 1, sStart - 1 + sCount),
        ...target.slice(tStart - 1 + tCount),
    ];
    return result.length > 0 ? result : [''];
}

/** Merges every region in both directions and checks each against expectedMerge. */
function expectMergesWork(left: string[], right: string[], options: DiffOptions = DEFAULT_DIFF_OPTIONS) {
    const result = computeDiff(left, right, options);
    for (const eol of ['\n', '\r\n']) {
        for (const region of result.regions) {
            expect(applyEdit(right, mergeEdit(region, 'left', left, right, eol), eol)).toEqual(expectedMerge(region, 'left', left, right));
            expect(applyEdit(left, mergeEdit(region, 'right', left, right, eol), eol)).toEqual(expectedMerge(region, 'right', left, right));
        }
    }
    return result;
}

/** Independent copy of the comparison key, so the invariant check doesn't trust the code under test. */
function keyOf(line: string, options: DiffOptions): string {
    let key = options.ignoreAllWhitespace ? line.replace(/\s/g, '') : options.ignoreTrimWhitespace ? line.trim() : line;
    if (options.ignoreCase) key = key.toLowerCase();
    return key;
}

/**
 * Regions are sorted, don't overlap, and together with equal (under the
 * options) matched lines cover both inputs exactly.
 */
function expectValidResult(left: string[], right: string[], options: DiffOptions, result: DiffResult) {
    let li = 0;
    let ri = 0;
    const expectMatched = (lCount: number, rCount: number) => {
        expect(lCount).toBe(rCount);
        for (let k = 0; k < lCount; k++) expect(keyOf(left[li + k], options)).toBe(keyOf(right[ri + k], options));
    };
    for (const region of result.regions) {
        const ls = region.leftStart - 1;
        const rs = region.rightStart - 1;
        expect(ls).toBeGreaterThanOrEqual(li);
        expect(rs).toBeGreaterThanOrEqual(ri);
        expectMatched(ls - li, rs - ri);
        expect(region.leftCount + region.rightCount).toBeGreaterThan(0);
        expect(region.kind).toBe(region.leftCount === 0 ? 'added' : region.rightCount === 0 ? 'removed' : 'modified');
        if (region.ignored) {
            expect(options.ignoreBlankLines).toBe(true);
            for (const line of left.slice(ls, ls + region.leftCount)) expect(line.trim()).toBe('');
            for (const line of right.slice(rs, rs + region.rightCount)) expect(line.trim()).toBe('');
        }
        if (region.kind === 'modified' && !region.ignored) {
            expect(region.lines).toHaveLength(Math.min(region.leftCount, region.rightCount));
            region.lines.forEach((pair, p) => {
                expect(pair.leftLine).toBe(region.leftStart + p);
                expect(pair.rightLine).toBe(region.rightStart + p);
                for (const [ranges, text] of [[pair.left, left[pair.leftLine - 1]], [pair.right, right[pair.rightLine - 1]]] as const) {
                    let lastEnd = 1;
                    for (const range of ranges) {
                        expect(range.startColumn).toBeGreaterThanOrEqual(lastEnd);
                        expect(range.endColumn).toBeGreaterThan(range.startColumn);
                        expect(range.endColumn).toBeLessThanOrEqual(text.length + 1);
                        lastEnd = range.endColumn;
                    }
                }
            });
        } else {
            expect(region.lines).toEqual([]);
        }
        li = ls + region.leftCount;
        ri = rs + region.rightCount;
    }
    expectMatched(left.length - li, right.length - ri);
    expect(result.changeCount).toBe(result.regions.filter(region => !region.ignored).length);
}

/** Small seeded generator, so a failing random case can be reproduced. */
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('computeDiff lines', () => {
    it('reports nothing for equal documents, including two empty ones', () => {
        expect(computeDiff(['a', 'b'], ['a', 'b'], DEFAULT_DIFF_OPTIONS)).toEqual({ regions: [], changeCount: 0, approximate: false });
        expect(computeDiff([''], [''], DEFAULT_DIFF_OPTIONS).regions).toEqual([]);
    });

    it('places added and removed regions just before the next line', () => {
        const added = computeDiff(['a', 'c'], ['a', 'b', 'c'], DEFAULT_DIFF_OPTIONS);
        expect(added.regions).toEqual([{ leftStart: 2, leftCount: 0, rightStart: 2, rightCount: 1, kind: 'added', ignored: false, lines: [] }]);

        const atEnd = computeDiff(['a', 'b'], ['a', 'b', 'c', 'd'], DEFAULT_DIFF_OPTIONS);
        expect(atEnd.regions).toEqual([{ leftStart: 3, leftCount: 0, rightStart: 3, rightCount: 2, kind: 'added', ignored: false, lines: [] }]);

        const atStart = computeDiff(['x', 'a', 'b'], ['a', 'b'], DEFAULT_DIFF_OPTIONS);
        expect(atStart.regions).toEqual([{ leftStart: 1, leftCount: 1, rightStart: 1, rightCount: 0, kind: 'removed', ignored: false, lines: [] }]);
        expect(atStart.changeCount).toBe(1);
    });

    it('pairs the lines of a modified region in order, with character ranges', () => {
        const result = computeDiff(['keep', 'const a = 1;', 'x', 'keep 2'], ['keep', 'const a = 2;', 'keep 2'], DEFAULT_DIFF_OPTIONS);
        expect(result.regions).toHaveLength(1);
        const [region] = result.regions;
        expect(region).toMatchObject({ leftStart: 2, leftCount: 2, rightStart: 2, rightCount: 1, kind: 'modified', ignored: false });
        expect(region.lines).toEqual([{ leftLine: 2, rightLine: 2, left: [{ startColumn: 11, endColumn: 12 }], right: [{ startColumn: 11, endColumn: 12 }] }]);
    });

    it('keeps separate regions for separate changes and aligns around unique lines', () => {
        const left = ['import a', 'function f() {', '    return 1;', '}', '', 'function g() {', '    return 2;', '}'];
        const right = ['import a', 'function f() {', '    return 10;', '}', '', 'function g() {', '    return 2;', '    // done', '}'];
        const result = expectMergesWork(left, right);
        expect(result.regions.map(r => [r.leftStart, r.leftCount, r.rightStart, r.rightCount, r.kind])).toEqual([
            [3, 1, 3, 1, 'modified'],
            [8, 0, 8, 1, 'added'],
        ]);
        expectValidResult(left, right, DEFAULT_DIFF_OPTIONS, result);
    });

    it('moves a block as a removal and an addition rather than one big change', () => {
        const left = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
        const right = ['c1', 'c2', 'a1', 'a2', 'b1', 'b2'];
        const result = computeDiff(left, right, DEFAULT_DIFF_OPTIONS);
        expect(result.regions.map(r => r.kind)).toEqual(['added', 'removed']);
        expectValidResult(left, right, DEFAULT_DIFF_OPTIONS, result);
    });

    it('handles a document against an empty one', () => {
        const result = expectMergesWork(['a', 'b'], ['']);
        expect(result.regions).toEqual([{
            leftStart: 1, leftCount: 2, rightStart: 1, rightCount: 1, kind: 'modified', ignored: false,
            lines: [{ leftLine: 1, rightLine: 1, left: [{ startColumn: 1, endColumn: 2 }], right: [] }],
        }]);
    });
});

describe('computeDiff options', () => {
    it('ignores leading and trailing whitespace, but not whitespace inside a line', () => {
        const options = opts({ ignoreTrimWhitespace: true });
        expect(computeDiff(['  a', 'b\t'], ['a', '  b  '], options).regions).toEqual([]);
        const inner = computeDiff(['  a b'], ['ab   '], options);
        expect(inner.regions).toHaveLength(1);
        expect(inner.regions[0].lines[0]).toEqual({ leftLine: 1, rightLine: 1, left: [{ startColumn: 4, endColumn: 5 }], right: [] });
    });

    it('ignores all whitespace differences', () => {
        const options = opts({ ignoreAllWhitespace: true });
        expect(computeDiff(['a b', 'f ( x )'], ['ab', 'f(x)'], options).regions).toEqual([]);
        const result = computeDiff(['call( a, b )'], ['call(a,c)'], options);
        expect(result.regions[0].lines[0]).toEqual({ leftLine: 1, rightLine: 1, left: [{ startColumn: 10, endColumn: 11 }], right: [{ startColumn: 8, endColumn: 9 }] });
    });

    it('ignores case, keeping columns on the original text', () => {
        const options = opts({ ignoreCase: true });
        expect(computeDiff(['Hello World'], ['hello world'], options).regions).toEqual([]);
        const result = computeDiff(['Hello World'], ['HELLO there'], options);
        expect(result.regions[0].lines[0]).toEqual({ leftLine: 1, rightLine: 1, left: [{ startColumn: 7, endColumn: 12 }], right: [{ startColumn: 7, endColumn: 12 }] });
    });

    it('reports added or removed blank lines as ignored regions that keep the sides aligned', () => {
        const options = opts({ ignoreBlankLines: true });
        const removed = computeDiff(['a', '', '  ', 'b'], ['a', 'b'], options);
        expect(removed).toEqual({
            regions: [{ leftStart: 2, leftCount: 2, rightStart: 2, rightCount: 0, kind: 'removed', ignored: true, lines: [] }],
            changeCount: 0,
            approximate: false,
        });
        const added = computeDiff(['a', 'b'], ['', 'a', 'b', ''], options);
        expect(added.regions.map(r => [r.leftStart, r.rightStart, r.rightCount, r.ignored])).toEqual([[1, 1, 1, true], [3, 4, 1, true]]);
        expect(added.changeCount).toBe(0);
        // Different blank lines on both sides: still ignored.
        const differing = computeDiff(['a', '   ', 'b'], ['a', '', 'b'], options);
        expect(differing.regions).toMatchObject([{ kind: 'modified', ignored: true, lines: [] }]);
        // Equal blank lines are simply matched.
        expect(computeDiff(['a', '', 'b'], ['a', '', 'b'], options).regions).toEqual([]);
        expectMergesWork(['a', '', '  ', 'b'], ['a', 'b'], options);
    });

    it('keeps blank lines inside a real change as part of it', () => {
        const options = opts({ ignoreBlankLines: true });
        const result = computeDiff(['a', 'x', '', 'z', 'b'], ['a', 'y', '', 'w', 'b'], options);
        expect(result.regions).toHaveLength(1);
        const [region] = result.regions;
        expect(region).toMatchObject({ leftStart: 2, leftCount: 3, rightStart: 2, rightCount: 3, kind: 'modified', ignored: false });
        // The blank pair is equal under the options, so it has no ranges.
        expect(region.lines[1]).toEqual({ leftLine: 3, rightLine: 3, left: [], right: [] });
        expect(result.changeCount).toBe(1);
        // Without the option, the blank line matches and splits the change in two.
        expect(computeDiff(['a', 'x', '', 'z', 'b'], ['a', 'y', '', 'w', 'b'], DEFAULT_DIFF_OPTIONS).changeCount).toBe(2);
    });

    it('matches lines that are equal under the options', () => {
        const options = opts({ ignoreCase: true });
        const result = computeDiff(['a', 'X', 'Same', 'b'], ['a', 'Y', 'Z', 'SAME', 'b'], options);
        expectValidResult(['a', 'X', 'Same', 'b'], ['a', 'Y', 'Z', 'SAME', 'b'], options, result);
        // 'Same' matches 'SAME', so it isn't part of the change.
        expect(result.regions).toMatchObject([{ leftStart: 2, leftCount: 1, rightStart: 2, rightCount: 2 }]);
    });
});

describe('computeDiff characters', () => {
    it('merges changes separated by one or two equal characters', () => {
        const near = computeDiff(['abcdef'], ['xbcyef'], DEFAULT_DIFF_OPTIONS).regions[0].lines[0];
        expect(near.left).toEqual([{ startColumn: 1, endColumn: 5 }]);
        expect(near.right).toEqual([{ startColumn: 1, endColumn: 5 }]);
        const far = computeDiff(['abcdefgh'], ['xbcdefgy'], DEFAULT_DIFF_OPTIONS).regions[0].lines[0];
        expect(far.left).toEqual([{ startColumn: 1, endColumn: 2 }, { startColumn: 8, endColumn: 9 }]);
    });

    it('reports an insertion only on the side that has it', () => {
        const pair = computeDiff(['let total = a;'], ['let total = a + b;'], DEFAULT_DIFF_OPTIONS).regions[0].lines[0];
        expect(pair.left).toEqual([]);
        expect(pair.right).toEqual([{ startColumn: 14, endColumn: 18 }]);
    });

    it('highlights very long lines as a whole', () => {
        const long = 'x'.repeat(2500);
        const pair = computeDiff([long], [`${long}y`], DEFAULT_DIFF_OPTIONS).regions[0].lines[0];
        expect(pair.left).toEqual([{ startColumn: 1, endColumn: 2501 }]);
        expect(pair.right).toEqual([{ startColumn: 1, endColumn: 2502 }]);
    });

    it('uses UTF-16 columns, as Monaco does', () => {
        const pair = computeDiff(['a😀b'], ['a😀c'], DEFAULT_DIFF_OPTIONS).regions[0].lines[0];
        expect(pair.left).toEqual([{ startColumn: 4, endColumn: 5 }]);
    });
});

describe('mergeEdit', () => {
    const cases: [string, string[], string[]][] = [
        ['a change in the middle', ['a', 'b', 'c'], ['a', 'x', 'c']],
        ['a change at the start', ['x', 'b', 'c'], ['a', 'b', 'c']],
        ['a change on the last line', ['a', 'b', 'x'], ['a', 'b', 'y']],
        ['lines only on one side, at the end', ['a', 'b', 'c', 'd'], ['a', 'b']],
        ['lines only on one side, at the start', ['x', 'y', 'a', 'b'], ['a', 'b']],
        ['lines only on one side, in the middle', ['a', 'x', 'y', 'b'], ['a', 'b']],
        ['an empty document', ['a', 'b'], ['']],
        ['an empty last line', ['a', 'b', ''], ['a', 'b']],
        ['a single blank line at the end', ['a', ''], ['a']],
        ['several separate changes', ['1', 'a', '2', '3', 'b', '4', 'c'], ['0', '1', '2', 'x', '3', '4']],
    ];
    for (const [name, left, right] of cases) {
        it(`copies ${name} exactly, either way`, () => {
            const result = expectMergesWork(left, right);
            expect(result.regions.length).toBeGreaterThan(0);
        });
    }

    it('removes the trailing lines without leaving an empty line behind', () => {
        const left = ['a'];
        const right = ['a', 'x', 'y'];
        const [region] = computeDiff(left, right, DEFAULT_DIFF_OPTIONS).regions;
        const edit = mergeEdit(region, 'left', left, right, '\n');
        expect(edit).toEqual({ startLineNumber: 1, startColumn: 2, endLineNumber: 3, endColumn: 2, text: '' });
        expect(applyEdit(right, edit, '\n')).toEqual(['a']);
    });

    it('appends after a last line that has no terminator', () => {
        const left = ['a', 'b', 'c'];
        const right = ['a'];
        const [region] = computeDiff(left, right, DEFAULT_DIFF_OPTIONS).regions;
        const edit = mergeEdit(region, 'left', left, right, '\r\n');
        expect(edit).toEqual({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2, text: '\r\nb\r\nc' });
    });

    it('inserts before a line with the target line ending', () => {
        const left = ['x', 'a'];
        const right = ['a'];
        const [region] = computeDiff(left, right, DEFAULT_DIFF_OPTIONS).regions;
        expect(mergeEdit(region, 'left', left, right, '\r\n')).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, text: 'x\r\n' });
    });

    it('empties the document when every line is removed', () => {
        const region: DiffRegion = { leftStart: 1, leftCount: 0, rightStart: 1, rightCount: 2, kind: 'added', ignored: false, lines: [] };
        expect(applyEdit(['x', 'y'], mergeEdit(region, 'left', [], ['x', 'y'], '\n'), '\n')).toEqual(['']);
    });
});

describe('computeDiff on random input', () => {
    const alphabet = ['a', 'b', 'c', 'd', 'A', ' a', 'a ', 'a b', 'ab', '', '  ', '\t', 'x y z'];
    const pick = (rand: () => number) => alphabet[Math.floor(rand() * alphabet.length)];
    const document = (rand: () => number) => Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pick(rand));
    const mutate = (rand: () => number, lines: string[]) => {
        const out = [...lines];
        const edits = Math.floor(rand() * 4);
        for (let e = 0; e < edits; e++) {
            const at = Math.floor(rand() * (out.length + 1));
            const roll = rand();
            if (roll < 0.33) out.splice(at, 0, pick(rand));
            else if (roll < 0.66 && out.length > 1) out.splice(Math.min(at, out.length - 1), 1);
            else out[Math.min(at, out.length - 1)] = pick(rand);
        }
        return out;
    };

    it('covers both sides exactly, and merging every region left-to-right reproduces the left side', () => {
        const rand = random(12345);
        for (let run = 0; run < 1500; run++) {
            const left = document(rand);
            const right = rand() < 0.7 ? mutate(rand, left) : document(rand);
            const result = computeDiff(left, right, DEFAULT_DIFF_OPTIONS);
            expectValidResult(left, right, DEFAULT_DIFF_OPTIONS, result);
            expect(result.approximate).toBe(false);
            expect(result.regions.every(region => !region.ignored)).toBe(true);

            for (const eol of ['\n', '\r\n']) {
                let toLeft = right;
                let toRight = left;
                for (const region of [...result.regions].reverse()) {
                    toLeft = applyEdit(toLeft, mergeEdit(region, 'left', left, right, eol), eol);
                    toRight = applyEdit(toRight, mergeEdit(region, 'right', left, right, eol), eol);
                }
                expect(toLeft).toEqual(left);
                expect(toRight).toEqual(right);
            }
        }
    });

    it('keeps the invariants under every combination of options', () => {
        const rand = random(777);
        for (let run = 0; run < 1500; run++) {
            const options: DiffOptions = {
                ignoreTrimWhitespace: rand() < 0.5,
                ignoreAllWhitespace: rand() < 0.5,
                ignoreCase: rand() < 0.5,
                ignoreBlankLines: rand() < 0.5,
            };
            const left = document(rand);
            const right = rand() < 0.7 ? mutate(rand, left) : document(rand);
            expectValidResult(left, right, options, computeDiff(left, right, options));
        }
    });
});

describe('computeDiff on large input', () => {
    const line = (i: number) => `    value_${i} = compute(${i % 97}, "${(Math.imul(i, 2654435761) >>> 0).toString(36)}");`;

    it('diffs 200,000 lines with scattered changes quickly and exactly', () => {
        const left = Array.from({ length: 200_000 }, (_, i) => line(i));
        const right = [...left];
        // Applied from the end so earlier positions stay put.
        right.splice(190_000, 2);
        right.splice(150_000, 0, 'inserted 1', 'inserted 2');
        right[120_000] = 'changed';
        right[80_000] = `${right[80_000]} // edited`;
        right.splice(40_000, 1);
        right[5] = 'changed at the start';
        right[0] = 'first';

        const started = performance.now();
        const result = computeDiff(left, right, DEFAULT_DIFF_OPTIONS);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(2000);
        expect(result.approximate).toBe(false);
        expect(result.regions.map(r => [r.leftStart, r.leftCount, r.rightStart, r.rightCount])).toEqual([
            [1, 1, 1, 1],
            [6, 1, 6, 1],
            [40_001, 1, 40_001, 0],
            [80_001, 1, 80_000, 1],
            [120_001, 1, 120_000, 1],
            [150_001, 0, 150_000, 2],
            [190_001, 2, 190_002, 0],
        ]);
        expect(result.regions[3].lines[0].right).toEqual([{ startColumn: line(80_000).length + 1, endColumn: line(80_000).length + 11 }]);
    });

    it('diffs 200,000 lines full of repeated lines without giving up', () => {
        const left = Array.from({ length: 200_000 }, (_, i) => (i % 3 === 0 ? '}' : i % 3 === 1 ? '' : line(i)));
        const right = [...left];
        right[150_000] = '{';
        right.splice(100_000, 3);
        right[30_001] = 'x';

        const started = performance.now();
        const result = computeDiff(left, right, DEFAULT_DIFF_OPTIONS);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(2000);
        expect(result.approximate).toBe(false);
        expect(result.changeCount).toBe(3);
        expectValidResult(left, right, DEFAULT_DIFF_OPTIONS, result);
    });

    it('reports two unrelated 20,000-line documents as one approximate block without hanging', () => {
        const left = Array.from({ length: 20_000 }, (_, i) => `left ${i} ${i * 7}`);
        const right = Array.from({ length: 20_000 }, (_, i) => `right ${i} ${i * 13}`);

        const started = performance.now();
        const result = computeDiff(left, right, DEFAULT_DIFF_OPTIONS);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(2000);
        expect(result.approximate).toBe(true);
        expect(result.changeCount).toBeGreaterThan(0);
        expectValidResult(left, right, DEFAULT_DIFF_OPTIONS, result);
    });
});

describe('runHeavyTask diff', () => {
    it('returns the diff as JSON', () => {
        const left = ['a', 'b'];
        const right = ['a', 'c'];
        const json = runHeavyTask({ kind: 'diff', left, right, options: DEFAULT_DIFF_OPTIONS });
        expect(JSON.parse(json)).toEqual(computeDiff(left, right, DEFAULT_DIFF_OPTIONS));
    });
});
