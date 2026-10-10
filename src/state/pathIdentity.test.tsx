// @vitest-environment jsdom
/**
 * Document path identity:
 * rename and Save As keep one tab per file and move `--wait` bookkeeping
 * with the document. Drives the real hooks; only the Tauri boundary is mocked.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileReadResult, FileWriteResult } from '../utils/fileOperations';

const io = vi.hoisted(() => ({
    invoke: vi.fn(),
    readFileContent: vi.fn(),
    writeFileContent: vi.fn(),
    saveFileDialog: vi.fn(),
    ask: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: io.ask }));
vi.mock('../services/ErrorService', () => ({
    errorService: { showWarning: io.showWarning, showError: io.showError, showSuccess: vi.fn() },
}));
vi.mock('../utils/fileWatcher', () => ({
    fileWatcher: { watch: vi.fn(), unwatch: vi.fn(), updateVersion: vi.fn(), beginWrite: vi.fn(), endWrite: vi.fn(), unwatchOwner: vi.fn(), isPendingDeletion: vi.fn(() => false) },
}));
vi.mock('../utils/fileOperations', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/fileOperations')>();
    return {
        ...actual,
        readFileContent: io.readFileContent,
        writeFileContent: io.writeFileContent,
        saveFileDialog: io.saveFileDialog,
        openFileDialog: vi.fn(),
        addRecentFile: vi.fn(async () => {}),
        rebuildNativeMenu: vi.fn(async () => {}),
    };
});

import { useTabManager } from './useTabManager';
import { useFileManager } from './useFileManager';
import { fileNameError, suggestedFileName } from '../utils/fileNames';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function readResult(path: string, content = 'text'): FileReadResult {
    return { path, content, encoding: 'UTF-8', modified: 100, size: content.length, hash: 'h1', identity: 'id' };
}
function writeResult(content: string): FileWriteResult {
    return { encoding: 'UTF-8', modified: 200, size: content.length, hash: 'h2', identity: 'id' } as FileWriteResult;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

function useHarness() {
    const tm = useTabManager();
    const fm = useFileManager(
        tm.tabs, tm.addTab, tm.updateTab, tm.markTabSaved, tm.getTabSaveSnapshot,
        tm.findTabIdByPath, tm.setActiveTabId, tm.markExternallyModified,
    );
    return { tm, fm };
}

let harness: { current: ReturnType<typeof useHarness> };
let unmount: () => void;
beforeEach(() => {
    vi.resetAllMocks();
    const ref = { current: undefined as unknown as ReturnType<typeof useHarness> };
    function Probe() {
        ref.current = useHarness();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    harness = ref;
    unmount = () => act(() => root.unmount());
});
afterEach(() => unmount());

const tabs = () => harness.current.tm.tabs;
const tab = (id: string) => tabs().find(t => t.id === id);
const invokedCommands = () => io.invoke.mock.calls.map(call => call[0]);

async function open(path: string, resolvedPath = path): Promise<string | null> {
    io.readFileContent.mockResolvedValueOnce(readResult(resolvedPath));
    let id: string | null = null;
    await act(async () => { id = await harness.current.fm.openFile(path); });
    return id;
}

describe('One tab per file', () => {
    it('another spelling of an open file reuses its tab', async () => {
        const first = await open('/work/notes.txt');
        const second = await open('/work/link-to-notes.txt', '/work/notes.txt');
        expect(second).toBe(first);
        expect(tabs()).toHaveLength(1);
    });

    it('two quick opens of the same file make one tab', async () => {
        const read = deferred<FileReadResult>();
        io.readFileContent.mockReturnValueOnce(read.promise).mockResolvedValueOnce(readResult('/work/a.txt'));
        let ids: (string | null)[] = [];
        await act(async () => {
            const pending = Promise.all([
                harness.current.fm.openFile('/work/a.txt'),
                harness.current.fm.openFile('/work/./a.txt'),
            ]);
            read.resolve(readResult('/work/a.txt'));
            ids = await pending;
        });
        expect(tabs()).toHaveLength(1);
        expect(ids[1]).toBe(ids[0]);
    });
});

describe('Concurrent opens of one path', () => {
    it('both get the tab id instead of one getting null', async () => {
        const read = deferred<FileReadResult>();
        io.readFileContent.mockReturnValueOnce(read.promise);
        let ids: (string | null)[] = [];
        await act(async () => {
            const pending = Promise.all([
                harness.current.fm.openFile('/work/same.txt'),
                harness.current.fm.openFile('/work/same.txt'),
            ]);
            read.resolve(readResult('/work/same.txt'));
            ids = await pending;
        });
        expect(ids[0]).not.toBeNull();
        expect(ids[1]).toBe(ids[0]);
        expect(io.readFileContent).toHaveBeenCalledTimes(1);
    });
});

describe('Rename', () => {
    it('ignores an unchanged name and rejects invalid ones without touching the disk', async () => {
        const id = (await open('/work/notes.txt'))!;
        await act(async () => { await harness.current.fm.renameFile(id, ' notes.txt '); });
        await act(async () => { await harness.current.fm.renameFile(id, 'a/b.txt'); });
        await act(async () => { await harness.current.fm.renameFile(id, '   '); });
        expect(invokedCommands()).not.toContain('rename_file');
        expect(io.showError).toHaveBeenCalledTimes(2);
    });

    it('keeps the tab as it was when the rename is cancelled', async () => {
        const id = (await open('/work/notes.txt'))!;
        io.invoke.mockResolvedValueOnce(false);
        await act(async () => { await harness.current.fm.renameFile(id, 'plan.txt'); });
        expect(tab(id)?.path).toBe('/work/notes.txt');
    });

    it('waits for a save in flight, which then cannot restore the old name', async () => {
        const id = (await open('/work/notes.txt'))!;
        act(() => harness.current.tm.updateTabContent(id, 'edited'));
        const write = deferred<FileWriteResult>();
        io.writeFileContent.mockReturnValueOnce(write.promise);
        io.invoke.mockResolvedValue(true);

        let save!: Promise<boolean>;
        let rename!: Promise<void>;
        await act(async () => {
            save = harness.current.fm.saveFile(id, undefined, { manual: true });
            rename = harness.current.fm.renameFile(id, 'plan.md');
        });
        expect(invokedCommands()).not.toContain('rename_file');
        await act(async () => { write.resolve(writeResult('edited')); await save; await rename; });

        expect(io.invoke).toHaveBeenCalledWith('rename_file', { oldPath: '/work/notes.txt', newPath: '/work/plan.md' });
        expect(tab(id)).toMatchObject({ path: '/work/plan.md', title: 'plan.md', language: 'markdown' });
    });
});

describe('Save As', () => {
    it('refuses a destination that is open in another tab', async () => {
        const id = (await open('/work/a.txt'))!;
        const other = (await open('/work/b.txt'))!;
        io.saveFileDialog.mockResolvedValueOnce('/work/b.txt');
        await act(async () => { await harness.current.fm.saveFileAs(id); });
        expect(io.writeFileContent).not.toHaveBeenCalled();
        expect(io.showError).toHaveBeenCalledWith('File is already open', expect.any(Error));
        expect(harness.current.tm.activeTabId).toBe(other);
    });

    it('moves the --wait bookkeeping to the new path', async () => {
        const id = (await open('/work/a.txt'))!;
        io.saveFileDialog.mockResolvedValueOnce('/work/c.txt');
        io.writeFileContent.mockResolvedValueOnce(writeResult('text'));
        io.invoke.mockResolvedValue(undefined);
        await act(async () => { await harness.current.fm.saveFileAs(id); });
        expect(io.invoke).toHaveBeenCalledWith('retarget_document', { oldPath: '/work/a.txt', newPath: '/work/c.txt' });
        expect(tab(id)?.path).toBe('/work/c.txt');
    });

    it('offers a name with the language extension and accepts it', async () => {
        let id = '';
        act(() => { id = harness.current.tm.createNewTab(); });
        act(() => harness.current.tm.updateTab(id, { language: 'python', content: 'print(1)' }));
        io.saveFileDialog.mockImplementationOnce(async (name: string) => `/work/${name}`);
        io.writeFileContent.mockResolvedValueOnce(writeResult('print(1)'));
        let saved = false;
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { manual: true }); });
        expect(io.saveFileDialog).toHaveBeenCalledWith(expect.stringMatching(/^Untitled.*\.py$/));
        expect(saved).toBe(true);
        expect(tab(id)?.language).toBe('python');
    });
});

describe('File names', () => {
    it('validates names like the backend does', () => {
        expect(fileNameError('notes.md', false)).toBeNull();
        expect(fileNameError('..', false)).not.toBeNull();
        expect(fileNameError('a\\b', false)).not.toBeNull();
        expect(fileNameError('CON.txt', true)).not.toBeNull();
        expect(fileNameError('a:b', true)).not.toBeNull();
        expect(fileNameError('name.', true)).not.toBeNull();
        expect(fileNameError('a:b', false)).toBeNull();
    });

    it('suggests the language extension for a name without one', () => {
        expect(suggestedFileName('Untitled-2', 'typescript')).toBe('Untitled-2.ts');
        expect(suggestedFileName('Untitled-2', 'plaintext')).toBe('Untitled-2.txt');
        expect(suggestedFileName('Recovered - notes.md', 'plaintext')).toBe('Recovered - notes.md');
    });
});
