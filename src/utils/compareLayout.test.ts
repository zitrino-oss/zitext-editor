import { describe, expect, it } from 'vitest';
import { computeDiff, DEFAULT_DIFF_OPTIONS } from './textDiff';
import { alignmentZones, anchorLine, changeAtOrAfter, changeSummary } from './compareLayout';

const diff = (left: string[], right: string[], options = DEFAULT_DIFF_OPTIONS) => computeDiff(left, right, options);

/** Rows each side takes once fillers are added: the two must match. */
function paddedHeight(lines: number, zones: { heightInLines: number }[]): number {
    return lines + zones.reduce((sum, zone) => sum + zone.heightInLines, 0);
}

describe('side-by-side alignment', () => {
    it('pads the shorter side of each change so following lines stay level', () => {
        const left = ['a', 'b', 'c', 'd'];
        const right = ['a', 'x', 'y', 'z', 'c'];
        const { regions } = diff(left, right);
        const zones = alignmentZones(regions);
        expect(zones.left).toEqual([{ afterLineNumber: 2, heightInLines: 2 }]);
        expect(zones.right).toEqual([{ afterLineNumber: 5, heightInLines: 1 }]);
        expect(paddedHeight(left.length, zones.left)).toBe(paddedHeight(right.length, zones.right));
    });

    it('puts filler above the first line for an insertion at the top', () => {
        const zones = alignmentZones(diff(['b'], ['a', 'b']).regions);
        expect(zones.left).toEqual([{ afterLineNumber: 0, heightInLines: 1 }]);
    });

    it('still pads blank lines that "Ignore blank lines" doesn\'t show as changes', () => {
        const left = ['a', 'b'];
        const right = ['a', '', '', 'b'];
        const result = diff(left, right, { ...DEFAULT_DIFF_OPTIONS, ignoreBlankLines: true });
        expect(result.changeCount).toBe(0);
        const zones = alignmentZones(result.regions);
        expect(paddedHeight(left.length, zones.left)).toBe(paddedHeight(right.length, zones.right));
    });

    it('keeps both sides the same height for random edits', () => {
        let seed = 7;
        const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        for (let run = 0; run < 200; run++) {
            const left = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
            const right = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
            const zones = alignmentZones(diff(left.length ? left : [''], right.length ? right : ['']).regions);
            expect(paddedHeight(left.length || 1, zones.left)).toBe(paddedHeight(right.length || 1, zones.right));
        }
    });
});

describe('change navigation', () => {
    const { regions } = diff(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'B', 'c', 'd', 'f']);

    it('anchors a change on each side, even where that side has no lines', () => {
        expect(regions.map(r => [anchorLine(r, 'left'), anchorLine(r, 'right')])).toEqual([[2, 2], [5, 4]]);
    });

    it('finds the next change from a line', () => {
        expect(changeAtOrAfter(regions, 'right', 1)).toBe(0);
        expect(changeAtOrAfter(regions, 'right', 3)).toBe(1);
        expect(changeAtOrAfter(regions, 'right', 5)).toBe(-1);
    });

    it('summarises', () => {
        expect(changeSummary(0, -1, false)).toBe('No differences');
        expect(changeSummary(0, -1, true)).toBe('No differences (some ignored)');
        expect(changeSummary(3, -1, false)).toBe('3 changes');
        expect(changeSummary(3, 1, false)).toBe('Change 2 of 3');
    });
});
