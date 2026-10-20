import { describe, expect, it } from 'vitest';
import { canOpenAnotherLogView, MAX_LOG_VIEWS, viewAfterClosing, type WorkspaceView } from './workspaceViews';

const log = (n: number): WorkspaceView => ({ id: `v${n}`, kind: 'log', path: `/logs/f${n}.log`, title: `f${n}.log` });

describe('Log viewer limit', () => {
    it('allows up to the backend limit and refuses one more before a tab is added', () => {
        const views = Array.from({ length: MAX_LOG_VIEWS - 1 }, (_, i) => log(i));
        expect(canOpenAnotherLogView(views)).toBe(true);
        expect(canOpenAnotherLogView([...views, log(99)])).toBe(false);
    });

    it('counts only log viewers, not compare views or the scratchpad', () => {
        const views: WorkspaceView[] = [
            ...Array.from({ length: MAX_LOG_VIEWS - 1 }, (_, i) => log(i)),
            { id: 's', kind: 'scratchpad', title: 'Scratchpad' },
            { id: 'c', kind: 'compare', title: 'a ↔ b', left: { kind: 'tab', tabId: 'a' }, right: { kind: 'tab', tabId: 'b' } },
        ];
        expect(canOpenAnotherLogView(views)).toBe(true);
    });
});

describe('View shown after closing the one on screen', () => {
    const views = [log(1), log(2), log(3)];

    it('shows the view that takes its place, as closing a document tab does', () => {
        expect(viewAfterClosing(views, 'v1')).toBe('v2');
        expect(viewAfterClosing(views, 'v2')).toBe('v3');
    });

    it('shows the one before it when the last view closes', () => {
        expect(viewAfterClosing(views, 'v3')).toBe('v2');
        expect(viewAfterClosing([log(1), log(2)], 'v2')).toBe('v1');
    });

    it('returns null when no other view is left, or the view is unknown', () => {
        expect(viewAfterClosing([log(1)], 'v1')).toBeNull();
        expect(viewAfterClosing([], 'v1')).toBeNull();
        expect(viewAfterClosing(views, 'missing')).toBeNull();
    });
});
