/**
 * Layout for the compare view, computed from the diff regions (textDiff.ts)
 * so it can be tested without an editor.
 */
import type { DiffRegion } from './textDiff';

export interface FillerZone {
    /** The filler goes below this line (0 = above the first line). */
    afterLineNumber: number;
    heightInLines: number;
}

/**
 * Side by side, a change with more lines on one side gets blank filler on the
 * other, so the lines after it stay level. Ignored regions (blank lines with
 * "Ignore blank lines") are padded too: they aren't shown as changes, but they
 * still shift everything below.
 */
export function alignmentZones(regions: DiffRegion[]): { left: FillerZone[]; right: FillerZone[] } {
    const left: FillerZone[] = [];
    const right: FillerZone[] = [];
    for (const region of regions) {
        const extra = region.rightCount - region.leftCount;
        if (extra > 0) {
            left.push({ afterLineNumber: region.leftStart - 1 + region.leftCount, heightInLines: extra });
        } else if (extra < 0) {
            right.push({ afterLineNumber: region.rightStart - 1 + region.rightCount, heightInLines: -extra });
        }
    }
    return { left, right };
}

/** The line a change is shown at on one side: its first line, or for a side
 *  with no lines, the line above the gap (line 1 at the very top). */
export function anchorLine(region: DiffRegion, side: 'left' | 'right'): number {
    const start = side === 'left' ? region.leftStart : region.rightStart;
    const count = side === 'left' ? region.leftCount : region.rightCount;
    return count > 0 ? start : Math.max(1, start - 1);
}

/** Index of the change at or after a line (for "next change" from where the
 *  cursor is), or -1 when every change is above it. */
export function changeAtOrAfter(changes: DiffRegion[], side: 'left' | 'right', line: number): number {
    return changes.findIndex(change => {
        const start = side === 'left' ? change.leftStart : change.rightStart;
        const count = side === 'left' ? change.leftCount : change.rightCount;
        // A change with no lines on this side sits where it is drawn: on its
        // anchor line, just above the gap.
        const last = count > 0 ? start + count - 1 : anchorLine(change, side);
        return last >= line;
    });
}

export function changeSummary(changeCount: number, current: number, ignoredOnly: boolean): string {
    if (changeCount === 0) return ignoredOnly ? 'No differences (some ignored)' : 'No differences';
    if (current < 0) return `${changeCount} ${changeCount === 1 ? 'change' : 'changes'}`;
    return `Change ${current + 1} of ${changeCount}`;
}
