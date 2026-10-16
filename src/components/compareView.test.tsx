// @vitest-environment jsdom
/**
 * File Compare: merges edit the right document (and reach its tab), read-only
 * sides are protected, options re-run the comparison, and a stale render can
 * never undo an edit made in the view. Monaco can't run in jsdom, so a small
 * stand-in editor and text model are used; the diff itself is the real one.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
    type Listener = () => void;
    interface Range { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
    class Model {
        lines: string[];
        disposed = false;
        version = 1;
        getVersionId() { return this.version; }
        listeners = new Set<Listener>();
        constructor(text: string, public uri: string) { this.lines = text.split('\n'); }
        getValue() { return this.lines.join('\n'); }
        getLinesContent() { return [...this.lines]; }
        getLineCount() { return this.lines.length; }
        getLineContent(line: number) { return this.lines[line - 1]; }
        getEOL() { return '\n'; }
        getFullModelRange() { return { startLineNumber: 1, startColumn: 1, endLineNumber: this.lines.length, endColumn: this.lines[this.lines.length - 1].length + 1 }; }
        isDisposed() { return this.disposed; }
        dispose() { this.disposed = true; registry.delete(this.uri); }
        onDidChangeContent(listener: Listener) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
        apply(edits: { range: Range; text: string }[]) {
            for (const { range, text } of [...edits].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber)) {
                const before = this.lines[range.startLineNumber - 1].slice(0, range.startColumn - 1);
                const after = this.lines[range.endLineNumber - 1].slice(range.endColumn - 1);
                const inserted = (before + text + after).split('\n');
                this.lines.splice(range.startLineNumber - 1, range.endLineNumber - range.startLineNumber + 1, ...inserted);
            }
            this.version++;
            this.listeners.forEach(listener => listener());
        }
        pushEditOperations(_: unknown, edits: { range: Range; text: string }[]) { this.apply(edits); return null; }
    }
    const registry = new Map<string, Model>();
    const editors: Record<string, unknown>[] = [];
    const monaco = {
        KeyMod: { CtrlCmd: 2048 },
        KeyCode: { KeyC: 33, KeyX: 54, KeyV: 52 },
        Uri: { parse: (value: string) => ({ toString: () => value, value }) },
        Range: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {} },
        editor: {
            OverviewRulerLane: { Full: 7 },
            EditorOption: { fontInfo: 50 },
            MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
            setTheme: () => {},
            getModel: (uri: { value: string }) => registry.get(uri.value) ?? null,
            createModel: (text: string, _language: string, uri: { value: string }) => {
                const model = new Model(text, uri.value);
                registry.set(uri.value, model);
                return model;
            },
            create: (host: HTMLElement, options: { model: Model; readOnly: boolean }) => {
                const mouse = new Set<(event: unknown) => void>();
                const editor = {
                    host, options, model: options.model, decorations: [] as { range: Range; options: Record<string, unknown> }[], zones: [] as { afterLineNumber: number; heightInLines: number }[],
                    getModel: () => editor.model,
                    onDidScrollChange: () => ({ dispose() {} }),
                    setScrollPosition: () => {},
                    dispose: () => { editor.model = null as unknown as Model; },
                    updateOptions: (next: Record<string, unknown>) => Object.assign(editor.options, next),
                    layout: () => {},
                    createDecorationsCollection: (list: { range: Range; options: Record<string, unknown> }[]) => {
                        editor.decorations = list;
                        return { clear: () => { if (editor.decorations === list) editor.decorations = []; } };
                    },
                    changeViewZones: (callback: (accessor: unknown) => void) => callback({
                        addZone: (zone: { afterLineNumber: number; heightInLines: number }) => { editor.zones.push(zone); return String(editor.zones.length); },
                        removeZone: () => { editor.zones = []; },
                    }),
                    getOption: () => ({ fontFamily: 'monospace', fontSize: 14, lineHeight: 20 }),
                    onMouseDown: (listener: (event: unknown) => void) => { mouse.add(listener); return { dispose: () => mouse.delete(listener) }; },
                    click: (event: unknown) => mouse.forEach(listener => listener(event)),
                    revealLineInCenter: () => {},
                    setPosition: () => {},
                    getPosition: () => ({ lineNumber: 1, column: 1 }),
                    pushUndoStop: () => {},
                    executeEdits: (_source: string, edits: { range: Range; text: string }[]) => { editor.model.apply(edits); return true; },
                    getAction: () => null,
                    actions: [] as string[],
                    addAction: (action: { id: string }) => { editor.actions.push(action.id); return { dispose() {} }; },
                    onDidFocusEditorText: () => ({ dispose() {} }),
                };
                editors.push(editor);
                return editor;
            },
        },
    };
    return { monaco, registry, editors, Model };
});

vi.mock('../monaco-config', () => ({ default: fake.monaco }));
vi.mock('../utils/editorModels', () => ({
    modelUriForTab: (id: string) => `inmemory://tab/${id}`,
    getModelForTab: (id: string) => fake.registry.get(`inmemory://tab/${id}`) ?? null,
}));

import { CompareView, type ResolvedSide } from './CompareView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; fake.registry.clear(); fake.editors.length = 0; });

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 300)); });

function setup(left: ResolvedSide, right: ResolvedSide) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const edited = vi.fn();
    const props = { viewId: 'v1', visible: true, editorTheme: 't', fontFamily: 'mono', fontSize: 14, onTabEdited: edited, onSaveTab: vi.fn(), onSwap: vi.fn(), onRegisterCommands: vi.fn() };
    const render = (l: ResolvedSide, r: ResolvedSide) => act(() => root.render(<CompareView {...props} left={l} right={r} />));
    render(left, right);
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    return { host, edited, render };
}

const tab = (tabId: string, content: string, extra: Partial<Extract<ResolvedSide, { kind: 'tab' }>> = {}): ResolvedSide =>
    ({ kind: 'tab', tabId, title: `${tabId}.txt`, content, language: 'plaintext', readOnly: false, isDirty: false, ...extra });
const snapshot = (text: string): ResolvedSide => ({ kind: 'snapshot', label: 'Clipboard', text, language: 'plaintext' });
const buttonNamed = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement;
const tabModel = (id: string) => fake.registry.get(`inmemory://tab/${id}`)!;

describe('File Compare', () => {
    it('shows the changes, with filler keeping the sides level', async () => {
        const { host } = setup(tab('a', 'one\ntwo\nthree'), tab('b', 'one\nTWO\nthree\nfour'));
        await settle();
        expect(host.querySelector('.compare-summary')?.textContent).toBe('Change 1 of 2');
        // The right editor is created first.
        const [right, left] = fake.editors as unknown as { decorations: { range: { startLineNumber: number }; options: { className?: string } }[]; zones: unknown[] }[];
        expect(right.decorations.filter(d => d.options.className?.startsWith('diff-line-added')).map(d => d.range.startLineNumber)).toEqual([2, 4]);
        expect(left.decorations.filter(d => d.options.className?.startsWith('diff-line-removed')).map(d => d.range.startLineNumber)).toEqual([2]);
        expect(left.zones).toEqual([{ afterLineNumber: 3, heightInLines: 1, domNode: expect.any(HTMLElement) }]);
    });

    it('copies a change into the other document, which reaches its tab', async () => {
        const { host, edited } = setup(tab('a', 'one\ntwo\nthree'), tab('b', 'one\nTWO\nthree\nfour'));
        await settle();
        act(() => buttonNamed(host, 'Copy to right →').click());
        expect(tabModel('b').getValue()).toBe('one\ntwo\nthree\nfour');
        expect(edited).toHaveBeenLastCalledWith('b', 'one\ntwo\nthree\nfour');
        await settle();
        expect(host.querySelector('.compare-summary')?.textContent).toBe('Change 1 of 1');

        // The arrow in the left margin does the same for the remaining change.
        const left = fake.editors[1] as unknown as { click: (event: unknown) => void };
        act(() => left.click({ target: { type: 2, position: { lineNumber: 3 }, element: { className: 'diff-glyph diff-glyph-to-right' } } }));
        expect(tabModel('b').getValue()).toBe('one\ntwo\nthree');
        await settle();
        expect(host.querySelector('.compare-summary')?.textContent).toBe('No differences');
    });

    it('ignores a second merge click until the comparison has caught up with the first', async () => {
        const { host } = setup(tab('a', 'A\nx\nB\ny'), tab('b', 'P\nQ\nx\nC\ny'));
        await settle();
        const left = fake.editors[1] as unknown as { click: (event: unknown) => void };
        const arrow = (line: number) => ({ target: { type: 2, position: { lineNumber: line }, element: { className: 'diff-glyph diff-glyph-to-right' } } });
        // Two quick clicks: the first change, then (from the old diff) the second.
        act(() => {
            left.click(arrow(1));
            left.click(arrow(3));
        });
        expect(tabModel('b').getValue()).toBe('A\nx\nC\ny');
        expect(buttonNamed(host, 'Copy to right →').disabled).toBe(true);
        await settle();
        // Once the diff is current again, the second change copies correctly.
        expect(buttonNamed(host, 'Copy to right →').disabled).toBe(false);
        act(() => left.click(arrow(3)));
        expect(tabModel('b').getValue()).toBe('A\nx\nB\ny');
    });

    it('does not report text the app put into a tab\'s model as an edit (Revert stays clean)', async () => {
        const { edited, render } = setup(tab('a', 'one'), tab('b', 'edited', { isDirty: true }));
        await settle();
        // Revert: App gives the tab its saved text, and an editor showing the
        // same tab pushes it into the shared model.
        render(tab('a', 'one'), tab('b', 'saved'));
        tabModel('b').apply([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 }, text: 'saved' }]);
        expect(edited).not.toHaveBeenCalled();
        // A real edit is still reported.
        tabModel('b').apply([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '>' }]);
        expect(edited).toHaveBeenCalledWith('b', '>saved');
    });

    it('gives both editors the app\'s clipboard menu items', async () => {
        setup(tab('a', 'x'), tab('b', 'y'));
        await settle();
        for (const editor of fake.editors as unknown as { actions: string[] }[]) {
            expect(editor.actions).toEqual(['zitext.clipboardCopy', 'zitext.clipboardCut', 'zitext.clipboardPaste']);
        }
    });

    it('never copies into a read-only side', async () => {
        const { host } = setup(snapshot('x\ny'), tab('b', 'x\nz', { readOnly: false }));
        await settle();
        expect(buttonNamed(host, '← Copy to left').disabled).toBe(true);
        expect(buttonNamed(host, 'Copy to right →').disabled).toBe(false);
        cleanup!();
        cleanup = undefined;

        const readOnly = setup(tab('c', 'x\ny'), tab('d', 'x\nz', { readOnly: true }));
        await settle();
        expect(buttonNamed(readOnly.host, 'Copy to right →').disabled).toBe(true);
        expect(tabModel('d').getValue()).toBe('x\nz');
    });

    it('re-compares with the options', async () => {
        const { host } = setup(tab('a', 'Hello\n\nWorld'), tab('b', 'hello\nWorld'));
        await settle();
        expect(host.querySelector('.compare-summary')?.textContent).toBe('Change 1 of 1');
        const check = (label: string) => act(() => {
            ([...host.querySelectorAll('label')].find(l => l.textContent === label)!.querySelector('input') as HTMLInputElement).click();
        });
        check('Ignore case');
        check('Ignore blank lines');
        await settle();
        expect(host.querySelector('.compare-summary')?.textContent).toBe('No differences (some ignored)');
    });

    it('picks up an outside change to a tab, but a stale render never undoes an edit made here', async () => {
        const { host, render } = setup(tab('a', 'one\ntwo'), tab('b', 'one\nTWO'));
        await settle();
        act(() => buttonNamed(host, 'Copy to right →').click());
        expect(tabModel('b').getValue()).toBe('one\ntwo');
        // A render that still carries the old text (before App saw the edit).
        render(tab('a', 'one\ntwo'), tab('b', 'one\nTWO'));
        expect(tabModel('b').getValue()).toBe('one\ntwo');
        // The tab really changed elsewhere (Reload): the model follows.
        render(tab('a', 'one\ntwo'), tab('b', 'reloaded'));
        expect(tabModel('b').getValue()).toBe('reloaded');
    });

    it('disposes its own snapshot models but leaves the tab\'s model to the tab', async () => {
        setup(snapshot('x'), tab('b', 'y'));
        await settle();
        const snapshotModel = fake.registry.get('inmemory://compare/v1/left')!;
        cleanup!();
        cleanup = undefined;
        expect(snapshotModel.isDisposed()).toBe(true);
        expect(tabModel('b').isDisposed()).toBe(false);
    });
});
