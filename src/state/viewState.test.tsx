// @vitest-environment jsdom
/**
 * Cursor and scroll moves don't re-render the app on every event:
 * the status bar follows the live cursor, tab state takes the
 * position once it settles, and an explicit position wins over a pending one.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabManager } from './useTabManager';
import { useLiveCursor } from '../utils/liveCursor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let manager!: ReturnType<typeof useTabManager>;
let renders = 0;
let live = { line: 0, column: 0 };
let unmount: () => void;

beforeEach(() => {
    vi.useFakeTimers();
    renders = 0;
    function Probe() {
        manager = useTabManager();
        renders++;
        return null;
    }
    function StatusProbe({ tabId }: { tabId: string | null }) {
        live = useLiveCursor(tabId, { line: -1, column: -1 });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    let id = '';
    act(() => { id = manager.createNewTab(); });
    const statusRoot = createRoot(document.createElement('div'));
    act(() => statusRoot.render(<StatusProbe tabId={id} />));
    unmount = () => act(() => { root.unmount(); statusRoot.unmount(); });
});
afterEach(() => { unmount(); vi.useRealTimers(); });

describe('cursor and scroll positions', () => {
    it('update the status bar at once and tab state only after they settle', () => {
        const id = manager.activeTabId!;
        const before = renders;
        act(() => {
            for (let line = 2; line <= 20; line++) manager.updateCursorPosition(id, line, 1);
            for (let top = 0; top < 500; top += 50) manager.updateScrollPosition(id, top, 0);
        });
        expect(live).toEqual({ line: 20, column: 1 });
        expect(renders).toBe(before); // no app re-render per move
        act(() => { vi.advanceTimersByTime(400); });
        expect(manager.tabs[0]).toMatchObject({ cursorLine: 20, scrollTop: 450 });
        expect(renders).toBe(before + 1);
    });

    it('an explicit position (Go to Line) is not overwritten by an earlier pending move', () => {
        const id = manager.activeTabId!;
        act(() => { manager.updateCursorPosition(id, 50, 3); });
        act(() => { manager.updateTab(id, { cursorLine: 10, cursorColumn: 1, revealRequest: 1 }); });
        act(() => { vi.advanceTimersByTime(400); });
        expect(manager.tabs[0]).toMatchObject({ cursorLine: 10, cursorColumn: 1 });
        expect(live).toEqual({ line: 10, column: 1 });
    });

    it('switching tabs keeps where the cursor was in the tab being left', () => {
        const first = manager.activeTabId!;
        act(() => { manager.updateCursorPosition(first, 7, 4); });
        act(() => { manager.createNewTab(); });
        expect(manager.tabs.find(tab => tab.id === first)).toMatchObject({ cursorLine: 7, cursorColumn: 4 });
    });
});
