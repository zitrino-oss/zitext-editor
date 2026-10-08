// @vitest-environment jsdom
/** File watcher ownership and single-flight polling. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { fileWatcher } from './fileWatcher';

const version = (modified: number) => ({ modified, size: 1, exists: true, identity: 'id' });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const check = () => (fileWatcher as unknown as { checkAllFiles(): Promise<void> }).checkAllFiles();

afterEach(() => { fileWatcher.unwatchAll(); invoke.mockReset(); });

describe('file watcher', () => {
    it('keeps watching a file until its last tab lets go', async () => {
        invoke.mockResolvedValue(version(1));
        const first = vi.fn();
        const second = vi.fn();
        fileWatcher.watch('/work/a.txt', 'tab-1', first);
        fileWatcher.watch('/work/a.txt', 'tab-2', second);
        await flush();

        fileWatcher.unwatch('/work/a.txt', 'tab-1');
        invoke.mockResolvedValueOnce([{ path: '/work/a.txt', ...version(2) }]);
        await check();
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
    });

    it('runs one check at a time', async () => {
        invoke.mockResolvedValue(version(1));
        fileWatcher.watch('/net/share.txt', 'tab-1', () => {});
        await flush();

        let release!: (value: unknown) => void;
        invoke.mockReset();
        invoke.mockReturnValue(new Promise(resolve => { release = resolve; }));
        const running = check();
        await check();
        expect(invoke).toHaveBeenCalledTimes(1);
        release([]);
        await running;
    });

    it('stops watching every path a closed tab used, whatever it is called now', async () => {
        invoke.mockResolvedValue(version(1));
        fileWatcher.watch('/work/old-name.txt', 'tab-9', () => {});
        fileWatcher.watch('/work/new-name.txt', 'tab-9', () => {});
        await flush();
        fileWatcher.unwatchOwner('tab-9');

        invoke.mockClear();
        await check();
        expect(invoke).not.toHaveBeenCalled(); // nothing left to poll
    });
});

describe('polling while the window is hidden', () => {
    const setHidden = (hidden: boolean) =>
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

    it('stops while minimized and checks as soon as the window is back', async () => {
        vi.useFakeTimers();
        try {
            invoke.mockResolvedValue(version(1));
            fileWatcher.watch('/work/a.txt', 'tab-1', () => {});
            await vi.advanceTimersByTimeAsync(0);
            invoke.mockReset();
            invoke.mockResolvedValue([{ path: '/work/a.txt', ...version(1) }]);

            setHidden(true);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(invoke).not.toHaveBeenCalled();

            setHidden(false);
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
            expect(invoke).toHaveBeenCalledWith('get_files_metadata', { paths: ['/work/a.txt'] });
        } finally {
            setHidden(false);
            vi.useRealTimers();
        }
    });
});
