import { describe, expect, it } from 'vitest';
import { canOpenAnotherLogView, MAX_LOG_VIEWS, type WorkspaceView } from './workspaceViews';

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
