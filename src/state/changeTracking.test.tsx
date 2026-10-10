// @vitest-environment jsdom
/**
 * Change tracking and app data: the
 * changed-on-disk banner stays until the change is resolved, ZITEXT's own
 * save is not reported as an external change, mixed line endings are
 * disclosed, and failed settings writes are reported and taken back.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ invoke: vi.fn(), showWarning: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: env.invoke }));
vi.mock('../services/ErrorService', () => ({
    errorService: { showWarning: env.showWarning, showError: vi.fn(), showSuccess: vi.fn() },
}));

import { ExternalChangePrompt } from '../components/ExternalChangePrompt';
import { fileWatcher } from '../utils/fileWatcher';
import { analyzeLineEndings } from '../utils/fileOperations';
import { useSettingsManager } from './useSettingsManager';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; env.invoke.mockReset(); env.showWarning.mockReset(); fileWatcher.unwatchAll(); });

function mount(node: React.ReactNode) {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(node));
    cleanup = () => act(() => root.unmount());
    return host;
}

describe('Changed-on-disk banner', () => {
    it('stays visible when a reload is cancelled or fails', async () => {
        const host = mount(
            <ExternalChangePrompt tabId="t" fileName="a.txt" changeCount={1}
                onReload={() => Promise.resolve(false)} onIgnore={() => {}} />,
        );
        await act(async () => { (host.querySelector('.external-change-btn-primary') as HTMLButtonElement).click(); });
        expect(host.textContent).toContain('has been modified externally');
    });
});

describe('Own saves', () => {
    const version = (modified: number) => ({ modified, size: 1, exists: true, identity: 'id' });
    const check = () => (fileWatcher as unknown as { checkAllFiles(): Promise<void> }).checkAllFiles();

    it('a poll that overlaps ZITEXT\'s own save is not reported as an external change', async () => {
        env.invoke.mockResolvedValueOnce(version(1));
        const changed = vi.fn();
        fileWatcher.watch('/p/a.txt', 'tab', changed);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

        // The poll samples the file after the save replaced it, but its answer
        // arrives before the save has recorded the new version.
        let answer!: (value: unknown) => void;
        env.invoke.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
        fileWatcher.beginWrite('/p/a.txt');
        const poll = check();
        answer([{ path: '/p/a.txt', ...version(2) }]);
        await poll;
        fileWatcher.endWrite('/p/a.txt', version(2));
        expect(changed).not.toHaveBeenCalled();

        // A real external change afterwards is still reported.
        env.invoke.mockResolvedValueOnce([{ path: '/p/a.txt', ...version(3) }]);
        await check();
        expect(changed).toHaveBeenCalledTimes(1);
    });
});

describe('Line endings', () => {
    it('reports mixed styles and the style the editor will keep', () => {
        expect(analyzeLineEndings('a\r\nb\r\nc\n')).toEqual({ eol: 'Mixed', normalizedTo: 'CRLF', mixed: true });
        expect(analyzeLineEndings('a\rb\rc')).toEqual({ eol: 'Mixed', normalizedTo: 'CRLF', mixed: true });
        expect(analyzeLineEndings('a\nb\n')).toEqual({ eol: 'LF', normalizedTo: 'LF', mixed: false });
        expect(analyzeLineEndings('a\r\nb')).toEqual({ eol: 'CRLF', normalizedTo: 'CRLF', mixed: false });
    });
});

describe('Settings write failures', () => {
    it('are reported, and the failed change is not saved by the next write', async () => {
        let manager!: ReturnType<typeof useSettingsManager>;
        function Probe() { manager = useSettingsManager(); return null; }
        mount(<Probe />);
        const theme = manager.settings.theme;
        const otherTheme = theme === 'dark' ? 'light' : 'dark';

        env.invoke.mockRejectedValueOnce(new Error('disk full'));
        await act(async () => { await manager.updateSettings({ theme: otherTheme }); });
        expect(env.showWarning).toHaveBeenCalledWith(expect.stringContaining('disk full'));

        env.invoke.mockResolvedValueOnce(undefined);
        await act(async () => { await manager.updateSettings({ fontSize: 19 }); });
        const calls = env.invoke.mock.calls;
        const written = calls[calls.length - 1]?.[1] as { settings: { theme: string; fontSize: number } };
        expect(written.settings).toMatchObject({ theme, fontSize: 19 });
    });
});
