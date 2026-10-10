// @vitest-environment jsdom
/**
 * Regression tests for crash-recovery restore and the startup handoff.
 * Drives the real useEditorState startup sequence; only Tauri commands,
 * file reads, events and toasts are mocked.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionFile } from '../types';
import type { FileReadResult } from '../utils/fileOperations';

const env = vi.hoisted(() => ({
    commands: new Map<string, unknown>(),
    invoked: [] as string[],
    files: new Map<string, string>(),
    listeners: new Map<string, () => void>(),
    showWarning: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (command: string) => {
        env.invoked.push(command);
        return env.commands.get(command);
    }),
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (event: string, handler: () => void) => {
        env.listeners.set(event, handler);
        return () => env.listeners.delete(event);
    }),
}));
// Monaco is not needed for startup restore and does not load under jsdom.
vi.mock('../utils/editorModels', () => ({ disposeModelForTab: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(async () => true) }));
vi.mock('../services/ErrorService', () => ({
    errorService: { showWarning: env.showWarning, showError: vi.fn(), showSuccess: vi.fn() },
}));
vi.mock('../utils/fileWatcher', () => ({
    fileWatcher: { watch: vi.fn(), unwatch: vi.fn(), unwatchAll: vi.fn(), updateVersion: vi.fn(), beginWrite: vi.fn(), endWrite: vi.fn(), unwatchOwner: vi.fn(), isPendingDeletion: vi.fn(() => false) },
}));
vi.mock('../utils/fileOperations', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/fileOperations')>();
    return {
        ...actual,
        readFileContent: vi.fn(async (path: string): Promise<FileReadResult> => {
            const content = env.files.get(path);
            if (content === undefined) throw new Error(`No such file: ${path}`);
            return { content, encoding: 'UTF-8', modified: 1, size: content.length, hash: `hash:${content}`, identity: path } as FileReadResult;
        }),
        addRecentFile: vi.fn(async () => {}),
        rebuildNativeMenu: vi.fn(async () => {}),
        saveSession: vi.fn(async () => {}),
    };
});

import { useEditorState } from './useEditorState';
import { markOpenListenersReady } from '../utils/openRequests';
import { saveSession } from '../utils/fileOperations';

// App registers its open-file/open-folder listeners first; there is no App here.
markOpenListenersReady();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

let state: { current: ReturnType<typeof useEditorState> };

/** Polls outside act so each tick lets React flush pending state updates. */
async function waitUntil(condition: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    }
}
let unmount: () => void;

async function start() {
    const ref = { current: undefined as unknown as ReturnType<typeof useEditorState> };
    function Probe() {
        ref.current = useEditorState();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    state = ref;
    unmount = () => act(() => root.unmount());
    await waitUntil(() => state.current.isLoading === false);
}

const dirtyEntry = (path: string, content: string, extra: Partial<SessionFile> = {}): SessionFile => ({
    path, cursor_line: 1, cursor_column: 1, is_dirty: true, content, ...extra,
});

beforeEach(() => {
    env.commands.clear();
    env.invoked.length = 0;
    env.files.clear();
    env.listeners.clear();
    env.showWarning.mockClear();
    env.commands.set('settings_file_exists', true);
    env.commands.set('read_settings', {});
    env.commands.set('get_startup_args', []);
    env.commands.set('get_startup_folder', null);
});
afterEach(() => unmount?.());

describe('Recovery when the original file cannot be reopened', () => {
    it('opens the unsaved content in a "Recovered" tab instead of dropping it', async () => {
        env.commands.set('get_last_session', [dirtyEntry('/project/deleted.md', '# unsaved notes')]);
        await start();

        const recovered = state.current.tabs.find(t => t.title === 'Recovered - deleted.md');
        expect(recovered).toBeDefined();
        expect(recovered?.content).toBe('# unsaved notes');
        expect(recovered?.isDirty).toBe(true);
        expect(recovered?.path).toBeNull();
        expect(recovered?.language).toBe('markdown');
        expect(env.showWarning).toHaveBeenCalledWith(expect.stringContaining('could not be reopened'));
    });
});

describe('Launching with a file after a crash', () => {
    it('still restores the previous session, and the launched file becomes active', async () => {
        env.files.set('/project/a.txt', 'a on disk');
        env.files.set('/project/launched.txt', 'launched');
        env.commands.set('get_startup_args', ['/project/launched.txt']);
        env.commands.set('get_last_session', [
            dirtyEntry('/project/a.txt', 'a with unsaved edits'),
            { path: 'Untitled-1', cursor_line: 1, cursor_column: 1, is_untitled: true, content: 'scratch' },
        ]);
        await start();

        expect(env.invoked).toContain('get_last_session');
        const titles = state.current.tabs.map(t => t.title);
        expect(titles).toEqual(expect.arrayContaining(['a.txt', 'Untitled-1', 'launched.txt']));
        expect(state.current.tabs.find(t => t.title === 'a.txt')?.content).toBe('a with unsaved edits');
        expect(state.current.activeTab?.title).toBe('launched.txt');
    });

    it('a late "Restore" brings back the file entries that were held back', async () => {
        env.files.set('/project/a.txt', 'a on disk');
        // First fetch (prompt unanswered, backend timed out): untitled only.
        env.commands.set('get_last_session', [
            { path: 'Untitled-1', cursor_line: 1, cursor_column: 1, is_untitled: true, content: 'scratch' },
        ]);
        await start();
        expect(state.current.tabs.map(t => t.title)).toEqual(['Untitled-1']);

        // The user answers "Restore" later; the backend now releases everything.
        env.commands.set('get_last_session', [
            dirtyEntry('/project/a.txt', 'a with unsaved edits'),
            { path: 'Untitled-1', cursor_line: 1, cursor_column: 1, is_untitled: true, content: 'scratch' },
        ]);
        const lateRestore = env.listeners.get('session-restore-late');
        expect(lateRestore).toBeDefined();
        act(() => lateRestore!());
        await waitUntil(() => state.current.tabs.length === 2);

        expect(state.current.tabs.filter(t => t.title === 'Untitled-1')).toHaveLength(1);
        expect(state.current.tabs.find(t => t.title === 'a.txt')?.content).toBe('a with unsaved edits');
    });
});

describe('Startup handoff', () => {
    it('hands the launch folder to App and releases --wait for a file that cannot open', async () => {
        env.files.set('/project/ok.txt', 'fine');
        env.commands.set('get_last_session', []);
        env.commands.set('get_startup_args', ['/project/ok.txt', '/project/missing.txt']);
        env.commands.set('get_startup_folder', '/project');
        await start();

        expect(state.current.startupFolder).toBe('/project');
        expect(state.current.tabs.map(t => t.title)).toEqual(['ok.txt']);
        const { invoke } = await import('@tauri-apps/api/core');
        expect(invoke).toHaveBeenCalledWith('signal_tab_closed', { path: '/project/missing.txt' });
        expect(invoke).not.toHaveBeenCalledWith('signal_tab_closed', { path: '/project/ok.txt' });
    });
});

describe('Recovery snapshot after edits', () => {
    it('snapshots about two seconds after an edit, not only every 30 seconds', async () => {
        env.commands.set('get_last_session', []);
        await start();
        vi.mocked(saveSession).mockClear();
        const id = state.current.tabs[0].id;
        act(() => state.current.updateTabContent(id, 'typed'));
        await waitUntil(() => vi.mocked(saveSession).mock.calls.length > 0, 4000);
        const [tabs] = vi.mocked(saveSession).mock.calls[0];
        expect(tabs.find(t => t.id === id)?.content).toBe('typed');
    });
});

describe('Language detection for untitled documents', () => {
    const python = 'import os\n\ndef main():\n    print(os.getcwd())\n';

    it('detects pasted code', async () => {
        env.commands.set('get_last_session', []);
        await start();
        const id = state.current.tabs[0].id;
        act(() => state.current.updateTabContent(id, python));
        expect(state.current.tabs[0].language).toBe('python');
    });

    it('never overrides a language the user chose', async () => {
        env.commands.set('get_last_session', []);
        await start();
        const id = state.current.tabs[0].id;
        act(() => state.current.changeLanguage(id, 'plaintext'));
        act(() => state.current.updateTabContent(id, python));
        expect(state.current.tabs[0].language).toBe('plaintext');
    });
});
