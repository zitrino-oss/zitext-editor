// @vitest-environment jsdom
/**
 * Regression tests for the document save/reload/revert lifecycle: reload,
 * revert, autosave conflicts, read-only files, encodings and saving a closed
 * tab. They drive the real
 * useTabManager + useFileManager hooks; only the Tauri boundary (file I/O,
 * native dialogs, watcher, toasts) is mocked.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileReadResult, FileWriteResult } from '../utils/fileOperations';

const io = vi.hoisted(() => ({
    readFileContent: vi.fn(),
    writeFileContent: vi.fn(),
    saveFileDialog: vi.fn(),
    ask: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = '/project/notes.txt';

function readResult(content: string, hash: string): FileReadResult {
    return { content, encoding: 'UTF-8', modified: 100, size: content.length, hash, identity: 'id-1' } as FileReadResult;
}
function writeResult(content: string, hash: string): FileWriteResult {
    return { encoding: 'UTF-8', modified: 200, size: content.length, hash, identity: 'id-1' } as FileWriteResult;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const conflictError = () => new Error('ZITEXT_FILE_CONFLICT: file changed on disk since it was opened.');

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

function mount() {
    const ref = { current: undefined as unknown as ReturnType<typeof useHarness> };
    function Probe() {
        ref.current = useHarness();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    harness = ref;
    unmount = () => act(() => root.unmount());
}

const tab = (id: string) => harness.current.tm.tabs.find(t => t.id === id);

async function openFile(content = 'on disk v1', hash = 'h1'): Promise<string> {
    io.readFileContent.mockResolvedValueOnce(readResult(content, hash));
    let id: string | null = null;
    await act(async () => { id = await harness.current.fm.openFile(PATH); });
    expect(id).not.toBeNull();
    return id!;
}
function edit(id: string, content: string) {
    act(() => harness.current.tm.updateTabContent(id, content));
}

beforeEach(() => {
    vi.clearAllMocks();
    mount();
});
afterEach(() => unmount());

describe('Reload', () => {
    it('does not discard edits typed while the file is being read', async () => {
        const id = await openFile();
        const read = deferred<FileReadResult>();
        io.readFileContent.mockReturnValueOnce(read.promise);

        let reload!: Promise<boolean>;
        await act(async () => {
            reload = harness.current.fm.reloadFileFromDisk(id);
            await vi.waitFor(() => expect(io.readFileContent).toHaveBeenCalledTimes(2));
        });
        edit(id, 'typed during the read');
        await act(async () => { read.resolve(readResult('on disk v2', 'h2')); });

        await expect(reload).resolves.toBe(false);
        expect(tab(id)?.content).toBe('typed during the read');
        expect(tab(id)?.isDirty).toBe(true);
        expect(io.showWarning).toHaveBeenCalledWith(expect.stringContaining('changed while it was being read'));
    });

    it('applies the disk content when nothing changed during the read', async () => {
        const id = await openFile();
        io.readFileContent.mockResolvedValueOnce(readResult('on disk v2', 'h2'));
        let ok = false;
        await act(async () => { ok = await harness.current.fm.reloadFileFromDisk(id); });
        expect(ok).toBe(true);
        expect(tab(id)?.content).toBe('on disk v2');
        expect(tab(id)?.isDirty).toBe(false);
    });
});

describe('Format on Save after a reload', () => {
    it('saves the reloaded text, not formatter output captured before the reload', async () => {
        const id = await openFile();
        const read = deferred<FileReadResult>();
        io.readFileContent.mockReturnValueOnce(read.promise);
        io.writeFileContent.mockResolvedValue(writeResult('on disk v2', 'h3'));

        let reload!: Promise<boolean>;
        let save!: Promise<boolean>;
        await act(async () => {
            reload = harness.current.fm.reloadFileFromDisk(id);
            await vi.waitFor(() => expect(io.readFileContent).toHaveBeenCalledTimes(2));
            // Cmd+S while the reload is reading: the formatter ran on the old text.
            save = harness.current.fm.saveFile(id, 'formatted old text', { manual: true });
        });
        await act(async () => { read.resolve(readResult('on disk v2', 'h2')); await reload; await save; });

        expect(io.writeFileContent).toHaveBeenCalledTimes(1);
        expect(io.writeFileContent.mock.calls[0][1]).toBe('on disk v2');
    });
});

describe('Revert', () => {
    it('checks the expected disk version and asks before replacing an external change', async () => {
        const id = await openFile('saved baseline', 'h1');
        edit(id, 'my unsaved edits');
        io.writeFileContent.mockRejectedValueOnce(conflictError());
        io.ask.mockResolvedValueOnce(false); // user declines "Revert Anyway"

        let reverted = true;
        await act(async () => { reverted = await harness.current.fm.revertToBaseline(id); });

        expect(io.writeFileContent).toHaveBeenCalledTimes(1);
        const [, content, , expected] = io.writeFileContent.mock.calls[0];
        expect(content).toBe('saved baseline');
        expect(expected).toEqual({ modified: 100, size: 'saved baseline'.length, hash: 'h1' });
        expect(io.ask).toHaveBeenCalledWith(
            expect.stringContaining('Revert anyway?'),
            expect.objectContaining({ okLabel: 'Revert Anyway' }),
        );
        expect(reverted).toBe(false);
        expect(tab(id)?.content).toBe('my unsaved edits');
    });

    it('runs after a pending save and uses the version that save wrote', async () => {
        const id = await openFile('saved baseline', 'h1');
        edit(id, 'autosaved edits');
        const firstWrite = deferred<FileWriteResult>();
        io.writeFileContent
            .mockReturnValueOnce(firstWrite.promise)
            .mockResolvedValueOnce(writeResult('saved baseline', 'h3'));

        let save!: Promise<boolean>;
        let revert!: Promise<boolean>;
        await act(async () => {
            save = harness.current.fm.saveFile(id, undefined, { background: true });
            revert = harness.current.fm.revertToBaseline(id);
            await vi.waitFor(() => expect(io.writeFileContent).toHaveBeenCalledTimes(1));
        });
        // Revert is queued behind the in-flight save: no second write yet.
        expect(io.writeFileContent).toHaveBeenCalledTimes(1);

        await act(async () => {
            firstWrite.resolve(writeResult('autosaved edits', 'h2'));
            await save;
            await revert;
        });
        expect(io.writeFileContent).toHaveBeenCalledTimes(2);
        const [, content, , expected] = io.writeFileContent.mock.calls[1];
        expect(content).toBe('saved baseline');
        expect(expected).toMatchObject({ hash: 'h2' });
        expect(tab(id)?.content).toBe('saved baseline');
        expect(tab(id)?.isDirty).toBe(false);
    });
});

describe('Autosave conflicts', () => {
    it('never prompts; pauses autosave for the tab and raises the change banner', async () => {
        const id = await openFile();
        edit(id, 'edits');
        io.writeFileContent.mockRejectedValueOnce(conflictError());

        let saved = true;
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { background: true }); });
        expect(saved).toBe(false);
        expect(io.ask).not.toHaveBeenCalled();
        expect(tab(id)?.externallyModified).toBe(true);
        expect(io.showWarning).toHaveBeenCalledTimes(1);

        // Further autosaves skip the tab entirely (no disk access, no new toast).
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { background: true }); });
        expect(saved).toBe(false);
        expect(io.writeFileContent).toHaveBeenCalledTimes(1);
        expect(io.showWarning).toHaveBeenCalledTimes(1);
    });

    it('a manual save resolves the conflict and resumes autosave', async () => {
        const id = await openFile();
        edit(id, 'edits');
        io.writeFileContent.mockRejectedValueOnce(conflictError());
        await act(async () => { await harness.current.fm.saveFile(id, undefined, { background: true }); });

        io.writeFileContent
            .mockRejectedValueOnce(conflictError())
            .mockResolvedValueOnce(writeResult('edits', 'h2'));
        io.ask.mockResolvedValueOnce(true); // Overwrite
        let saved = false;
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { manual: true }); });
        expect(saved).toBe(true);
        expect(io.ask).toHaveBeenCalledTimes(1);
        // The disk now holds this document: the changed-on-disk banner goes.
        expect(tab(id)?.externallyModified).toBe(false);

        edit(id, 'more edits');
        io.writeFileContent.mockResolvedValueOnce(writeResult('more edits', 'h3'));
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { background: true }); });
        expect(saved).toBe(true);
        expect(io.writeFileContent).toHaveBeenCalledTimes(4);
    });

    it('does not open a Save As dialog for untitled tabs', async () => {
        let id = '';
        act(() => { id = harness.current.tm.createNewTab(); });
        edit(id, 'scratch');
        let saved = true;
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { background: true }); });
        expect(saved).toBe(false);
        expect(io.saveFileDialog).not.toHaveBeenCalled();
    });
});

const readOnlyError = () => new Error('Failed to write file: ZITEXT_READ_ONLY_FILE: this file is read-only on disk.');

describe('Read-only files', () => {
    it('a manual save asks first, then saves with permission', async () => {
        const id = await openFile();
        edit(id, 'edits');
        io.writeFileContent
            .mockRejectedValueOnce(readOnlyError())
            .mockResolvedValueOnce(writeResult('edits', 'h2'));
        io.ask.mockResolvedValueOnce(true); // Save Anyway
        let saved = false;
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { manual: true }); });
        expect(saved).toBe(true);
        expect(io.ask).toHaveBeenCalledTimes(1);
        expect(io.writeFileContent.mock.calls[0][4]).toBe(false);
        expect(io.writeFileContent.mock.calls[1][4]).toBe(true);
    });

    it('after Save Anyway, later saves (and autosave) don\'t ask or pause again', async () => {
        const id = await openFile();
        edit(id, 'edits');
        io.writeFileContent
            .mockRejectedValueOnce(readOnlyError())
            .mockResolvedValueOnce(writeResult('edits', 'h2'));
        io.ask.mockResolvedValueOnce(true); // Save Anyway
        await act(async () => { await harness.current.fm.saveFile(id, undefined, { manual: true }); });

        edit(id, 'more edits');
        io.writeFileContent.mockResolvedValueOnce(writeResult('more edits', 'h3'));
        let saved = false;
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { background: true }); });
        expect(saved).toBe(true);
        expect(io.writeFileContent.mock.calls[2][4]).toBe(true);
        expect(io.showWarning).not.toHaveBeenCalled();
    });

    it('cancelling leaves the file alone and the tab dirty', async () => {
        const id = await openFile();
        edit(id, 'edits');
        io.writeFileContent.mockRejectedValueOnce(readOnlyError());
        io.ask.mockResolvedValueOnce(false);
        await act(async () => { await harness.current.fm.saveFile(id, undefined, { manual: true }); });
        expect(io.writeFileContent).toHaveBeenCalledTimes(1);
        expect(tab(id)?.isDirty).toBe(true);
    });

    it('autosave never prompts; it pauses for the tab', async () => {
        const id = await openFile();
        edit(id, 'edits');
        io.writeFileContent.mockRejectedValueOnce(readOnlyError());
        let saved = true;
        await act(async () => { saved = await harness.current.fm.saveFile(id, undefined, { background: true }); });
        expect(saved).toBe(false);
        expect(io.ask).not.toHaveBeenCalled();
        expect(io.showWarning).toHaveBeenCalledWith(expect.stringContaining('read-only'));
        expect(io.showError).not.toHaveBeenCalled();
    });
});

describe('Encoding fidelity', () => {
    it('saves a file in the encoding it was opened with, BOM included', async () => {
        io.readFileContent.mockResolvedValueOnce({ ...readResult('a,b', 'h1'), encoding: 'UTF-8 with BOM' });
        let id: string | null = null;
        await act(async () => { id = await harness.current.fm.openFile(PATH); });
        edit(id!, 'a,b,c');
        io.writeFileContent.mockResolvedValueOnce({ ...writeResult('a,b,c', 'h2'), encoding: 'UTF-8 with BOM' });
        await act(async () => { await harness.current.fm.saveFile(id!, undefined, { manual: true }); });
        expect(io.writeFileContent.mock.calls[0][2]).toBe('UTF-8 with BOM');
        expect(tab(id!)?.encoding).toBe('UTF-8 with BOM');
    });
});

describe('Saving a closed tab', () => {
    it('a save queued behind the close never opens Save As or writes an empty file', async () => {
        const id = await openFile();
        edit(id, 'edited by user');
        const firstWrite = deferred<FileWriteResult>();
        io.writeFileContent.mockReturnValueOnce(firstWrite.promise);
        io.saveFileDialog.mockResolvedValue('/project/picked.txt');

        let first!: Promise<boolean>;
        let second!: Promise<boolean>;
        await act(async () => {
            first = harness.current.fm.saveFile(id, undefined, { manual: true });
            second = harness.current.fm.saveFile(id, undefined, { manual: true });
            await vi.waitFor(() => expect(io.writeFileContent).toHaveBeenCalledTimes(1));
        });
        await act(async () => {
            firstWrite.resolve(writeResult('edited by user', 'h2'));
            await first;
            harness.current.tm.closeTab(id); // close happens before the 2nd save runs
            await second;
        });

        await expect(second).resolves.toBe(false);
        expect(io.saveFileDialog).not.toHaveBeenCalled();
        expect(io.writeFileContent).toHaveBeenCalledTimes(1);
    });

    it('reload and revert of a closed tab do nothing', async () => {
        const id = await openFile();
        act(() => harness.current.tm.closeTab(id));
        let a = true, b = true;
        await act(async () => {
            a = await harness.current.fm.reloadFileFromDisk(id);
            b = await harness.current.fm.revertToBaseline(id);
        });
        expect([a, b]).toEqual([false, false]);
        expect(io.writeFileContent).not.toHaveBeenCalled();
    });
});
