// @vitest-environment jsdom
/**
 * Search and navigation:
 * search results land on their line, incomplete searches say so, the
 * explorer filter covers unexpanded folders and ignores stale loads, and a
 * previewed split pane is a Find target. Only Tauri and Monaco are faked.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
    // Monaco stand-ins: any member is a no-op function returning a disposable.
    const calls: [string, unknown[]][] = [];
    const deep = (name: string): unknown => new Proxy(function () {}, {
        get: (_target, key) => {
            if (key === Symbol.toPrimitive) return () => 0; // KeyMod.CtrlCmd | KeyCode.KeyF
            return key === 'dispose' ? () => {} : deep(`${name}.${String(key)}`);
        },
        apply: (_target, _this, args) => { calls.push([name, args]); return deep(`${name}()`); },
    });
    const editorProps: Record<string, unknown>[] = [];
    const invoke = vi.fn();
    return { calls, deep, editorProps, invoke };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('../monaco-config', () => ({ default: fake.deep('monaco') }));
vi.mock('monaco-editor', () => ({ editor: { ScrollType: { Immediate: 1 } } }));
vi.mock('@monaco-editor/react', () => ({
    default: (props: Record<string, unknown>) => { fake.editorProps.push(props); return null; },
}));
vi.mock('../utils/editorCommands', () => ({ copySelection: vi.fn(), cutSelection: vi.fn(), pasteFromClipboard: vi.fn() }));
vi.mock('../services/ErrorService', () => ({ errorService: { showError: vi.fn(), showWarning: vi.fn(), showSuccess: vi.fn() } }));

import { EditorPanel } from './EditorPanel';
import { FindInFiles } from './FindInFiles';
import { FileExplorer } from './FileExplorer';
import { SplitView } from './SplitView';
import { parseLineAndColumn } from '../utils/lineColumn';
import type { Settings, Tab } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; fake.calls.length = 0; fake.editorProps.length = 0; fake.invoke.mockReset(); });

function render(node: React.ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(node));
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    return { host, rerender: (next: React.ReactNode) => act(() => root.render(next)) };
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const sleep = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

describe('Opening a search result', () => {
    it('shows the line after the scroll restore, including on first mount', () => {
        render(
            <EditorPanel
                modelPath="inmemory://tab/9" content="x" language="plaintext" editorTheme="vs"
                fontSize={14} fontFamily="monospace" wordWrap={false} showMinimap={false}
                isReadOnly={false} enableColumnSelection={false} tabSize={4} insertSpaces
                cursorLine={250} cursorColumn={3} scrollTop={0} scrollLeft={0} revealRequest={1}
                onChange={() => {}} onCursorChange={() => {}}
            />,
        );
        const props = fake.editorProps[fake.editorProps.length - 1];
        const editor = fake.deep('editor');
        act(() => {
            (props.beforeMount as (m: unknown) => void)(fake.deep('monaco'));
            (props.onMount as (e: unknown, m: unknown) => void)(editor, fake.deep('monaco'));
        });
        const names = fake.calls.map(([name]) => name);
        const reveal = names.lastIndexOf('editor.revealPositionInCenter');
        expect(reveal).toBeGreaterThan(-1);
        expect(reveal).toBeGreaterThan(names.lastIndexOf('editor.setScrollPosition'));
        expect(fake.calls[reveal][1][0]).toEqual({ lineNumber: 250, column: 3 });
    });
});

describe('Reveal after a remount', () => {
    it('is not replayed when the editor view is recreated', () => {
        const panel = (
            <EditorPanel
                modelPath="inmemory://tab/remount" content="x" language="plaintext" editorTheme="vs"
                fontSize={14} fontFamily="monospace" wordWrap={false} showMinimap={false}
                isReadOnly={false} enableColumnSelection={false} tabSize={4} insertSpaces
                cursorLine={500} cursorColumn={1} scrollTop={0} scrollLeft={0} revealRequest={7}
                onChange={() => {}} onCursorChange={() => {}}
            />
        );
        const mount = () => {
            const { host } = render(panel);
            const props = fake.editorProps[fake.editorProps.length - 1];
            act(() => (props.onMount as (e: unknown, m: unknown) => void)(fake.deep('editor'), fake.deep('monaco')));
            return host;
        };
        mount();
        expect(fake.calls.filter(([name]) => name === 'editor.revealPositionInCenter')).toHaveLength(1);
        cleanup?.();
        // Toggling preview or split view remounts the view for the same document.
        mount();
        expect(fake.calls.filter(([name]) => name === 'editor.revealPositionInCenter')).toHaveLength(1);
    });
});

describe('Find in Files report', () => {
    it('says when a search could not cover everything', async () => {
        fake.invoke.mockResolvedValue({
            matches: [], resultLimitReached: false, stoppedEarly: true,
            skippedLargeFiles: 2, skippedEncodingFiles: 0, skippedDeepFolders: 0, skippedLinks: 1,
        });
        const { host } = render(<FindInFiles folderPath="/p" width={250} onOpenFile={() => {}} onOpenFolder={() => {}} onClose={() => {}} />);
        const input = host.querySelector('input') as HTMLInputElement;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await flush();
        const text = host.textContent ?? '';
        expect(text).toContain('in the files searched');
        expect(text).toContain('stopped early');
        expect(text).toContain('2 large files');
        expect(text).toContain('1 symbolic link');
        expect(text).toContain('unsaved changes are not included');
    });

    it('drops results when the folder changes', async () => {
        fake.invoke.mockResolvedValue({
            matches: [{ file_path: '/a/x.txt', line_number: 1, line_content: 'needle', match_start: 0, match_end: 6 }],
            resultLimitReached: false, stoppedEarly: false, skippedLargeFiles: 0, skippedEncodingFiles: 0, skippedDeepFolders: 0,
        });
        const props = { width: 250, onOpenFile: () => {}, onOpenFolder: () => {}, onClose: () => {} };
        const { host, rerender } = render(<FindInFiles folderPath="/a" {...props} />);
        const input = host.querySelector('input') as HTMLInputElement;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await flush();
        expect(host.textContent).toContain('x.txt');
        rerender(<FindInFiles folderPath="/b" {...props} />);
        expect(host.textContent).not.toContain('x.txt');
    });
});

describe('Explorer', () => {
    const explorer = (folderPath: string) => (
        <FileExplorer folderPath={folderPath} onFolderOpen={() => {}} onFileSelect={() => {}}
            activePath={null} dirtyPaths={new Set()} onClose={() => {}} collapsed={false}
            width={250} onWidthChange={() => {}} />
    );

    it('the filter finds files inside folders that were never expanded', async () => {
        fake.invoke.mockImplementation(async (command: string) => {
            if (command === 'read_directory') return { entries: [{ name: 'src', path: '/p/src', is_directory: true }], truncated: false };
            if (command === 'find_files_by_name') return {
                entries: [
                    { name: 'src', path: '/p/src', is_directory: true },
                    { name: 'deep', path: '/p/src/deep', is_directory: true },
                    { name: 'target.ts', path: '/p/src/deep/target.ts', is_directory: false },
                ],
                truncated: false,
            };
            return 0;
        });
        const { host } = render(explorer('/p'));
        await flush();
        const filter = host.querySelector('.file-explorer-search-input') as HTMLInputElement;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'target');
            filter.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await sleep(200);
        expect(host.textContent).toContain('target.ts');
        expect(host.textContent).not.toContain('No file names match');
    });

    it('a slow load for the previous folder never replaces the current tree', async () => {
        let releaseA!: (value: unknown) => void;
        fake.invoke.mockImplementation((command: string, args: { path: string }) => {
            if (command !== 'read_directory') return Promise.resolve(0);
            if (args.path === '/a') return new Promise(resolve => { releaseA = resolve; });
            return Promise.resolve({ entries: [{ name: 'b.txt', path: '/b/b.txt', is_directory: false }], truncated: false });
        });
        const { host, rerender } = render(explorer('/a'));
        rerender(explorer('/b'));
        await flush();
        releaseA({ entries: [{ name: 'a.txt', path: '/a/a.txt', is_directory: false }], truncated: false });
        await flush();
        expect(host.textContent).toContain('b.txt');
        expect(host.textContent).not.toContain('a.txt');
    });

    it('lists a huge folder in part instead of failing', async () => {
        fake.invoke.mockImplementation(async (command: string) => command === 'read_directory'
            ? { entries: [{ name: 'one.txt', path: '/p/one.txt', is_directory: false }], truncated: true }
            : 0);
        const { host } = render(explorer('/p'));
        await flush();
        expect(host.textContent).toContain('one.txt');
        expect(host.textContent).toContain('Only the first 5,000 items are shown');
    });

    it('says when the file count stopped early instead of showing it as exact', async () => {
        const answer = { count: 100000, partial: true };
        fake.invoke.mockImplementation(async (command: string) => command === 'read_directory'
            ? { entries: [], truncated: false }
            : command === 'count_project_files' ? answer : 0);
        const { host } = render(explorer('/p'));
        await flush();
        const footer = host.querySelector('.file-explorer-footer') as HTMLElement;
        expect(footer.textContent).toContain('100,000+ files');
        expect(footer.querySelector('[title]')?.getAttribute('title')).toContain('at least');
    });
});

describe('Find in a previewed split pane', () => {
    it('exposes each pane\'s rendered preview', async () => {
        const tab = (id: string, isPreview: boolean): Tab => ({
            id, path: `/p/${id}.md`, title: `${id}.md`, content: `# ${id}`, revision: 0, cursorLine: 1, cursorColumn: 1,
            isDirty: false, language: 'markdown', isReadOnly: false, encoding: 'UTF-8', diskVersion: null, eol: 'LF',
            scrollTop: 0, scrollLeft: 0, isUntitled: false, externallyModified: false, externalChangeCount: 0, isPreview,
        } as unknown as Tab);
        const left = { current: null as HTMLDivElement | null };
        const right = { current: null as HTMLDivElement | null };
        render(
            <SplitView leftTab={tab('left', false)} rightTab={tab('right', true)} settings={{} as Settings}
                onLeftChange={() => {}} onRightChange={() => {}} onLeftCursorChange={() => {}} onRightCursorChange={() => {}}
                onLeftScrollChange={() => {}} onRightScrollChange={() => {}} onLeftEditorReady={() => {}} onRightEditorReady={() => {}}
                leftPreviewRef={left} rightPreviewRef={right} />,
        );
        // The preview loads on first use.
        for (let i = 0; i < 20 && !right.current; i++) await flush();
        expect(left.current).toBeNull();
        expect(right.current).toBeInstanceOf(HTMLElement);
        expect(right.current!.closest('.split-pane-right')).not.toBeNull();
    });
});

describe('Go to Line', () => {
    it('reads "line:column"', () => {
        expect(parseLineAndColumn('12')).toEqual({ line: 12, column: 1 });
        expect(parseLineAndColumn('12:5')).toEqual({ line: 12, column: 5 });
        expect(parseLineAndColumn('12,5')).toEqual({ line: 12, column: 5 });
        expect(parseLineAndColumn('12:')).toBeNull();
    });
});
