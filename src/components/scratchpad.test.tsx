// @vitest-environment jsdom
/**
 * Scratchpad: typing is saved (debounced, in order, flushed on quit and when
 * the view closes), the saved text comes back, a failing disk is reported
 * once. Also the one-field prompt used by Split Lines and Mark Text.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
    const store = { saved: 'from last time', writes: [] as string[], failWrites: false, writeDelay: 0 };
    const invoke = vi.fn(async (command: string, args: { content?: string } = {}) => {
        if (command === 'read_scratchpad') return store.saved;
        if (command === 'write_scratchpad') {
            if (store.writeDelay) await new Promise(r => setTimeout(r, store.writeDelay));
            if (store.failWrites) throw new Error('disk full');
            store.saved = args.content!;
            store.writes.push(args.content!);
            return undefined;
        }
        throw new Error(command);
    });
    class Model {
        listeners = new Set<() => void>();
        disposed = false;
        language: string;
        constructor(public text: string, language: string) { this.language = language; }
        getValue() { return this.text; }
        onDidChangeContent(listener: () => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
        type(text: string) { this.text = text; this.listeners.forEach(listener => listener()); }
        dispose() { this.disposed = true; }
        isDisposed() { return this.disposed; }
    }
    const created: { model: Model; disposed: boolean; options: Record<string, unknown>; actions: string[] }[] = [];
    const models = new Map<string, Model>();
    const monaco = {
        KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyC: 1, KeyX: 2, KeyV: 3 },
        Uri: { parse: (value: string) => value },
        editor: {
            setTheme: () => {},
            getModel: (uri: string) => models.get(uri) ?? null,
            createModel: (text: string, language: string, uri: string) => {
                const model = new Model(text, language);
                models.set(uri, model);
                return model;
            },
            setModelLanguage: (model: Model, language: string) => { model.language = language; },
            create: (_host: HTMLElement, options: { model: Model }) => {
                const entry = { model: options.model, disposed: false, options: options as Record<string, unknown>, actions: [] as string[] };
                created.push(entry);
                return {
                    focus: () => {}, layout: () => {}, getModel: () => entry.model,
                    updateOptions: (next: Record<string, unknown>) => Object.assign(entry.options, next),
                    addAction: (action: { id: string }) => { entry.actions.push(action.id); },
                    getAction: () => null,
                    dispose: () => { entry.disposed = true; },
                };
            },
        },
    };
    return { store, invoke, monaco, created, models, showError: vi.fn() };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('../monaco-config', () => ({ default: fake.monaco }));
vi.mock('../services/ErrorService', () => ({ errorService: { showError: fake.showError, showWarning: vi.fn(), showSuccess: vi.fn() } }));

import { ScratchpadView } from './ScratchpadView';
import { InputPrompt } from './InputPrompt';
import { flushScratchpad, flushScratchpadBeforeQuit, scheduleScratchpadSave } from '../utils/scratchpad';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
beforeEach(() => {
    fake.store.saved = 'from last time';
    fake.store.writes = [];
    fake.store.failWrites = false;
    fake.store.writeDelay = 0;
    fake.created.length = 0;
    fake.models.clear();
    fake.showError.mockClear();
});
afterEach(async () => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); await flushScratchpad(); });

function render(node: React.ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(node));
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    return host;
}
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });

describe('Scratchpad', () => {
    it('brings back the saved text and saves what is typed', async () => {
        const host = render(<ScratchpadView visible editorTheme="t" fontFamily="mono" fontSize={14} wordWrap={false} onRegisterCommands={() => {}} />);
        await settle();
        const [editor] = fake.created;
        expect(editor.model.getValue()).toBe('from last time');
        expect(editor.actions).toEqual(['zitext.clipboardCopy', 'zitext.clipboardCut', 'zitext.clipboardPaste']);
        editor.model.type('SELECT 1;');
        editor.model.type('SELECT 1; -- notes');
        await act(async () => { await new Promise(r => setTimeout(r, 500)); });
        expect(fake.store.writes).toEqual(['SELECT 1; -- notes']); // typing is debounced into one save

        // Closing the view saves the last keystrokes at once.
        editor.model.type('last words');
        cleanup!();
        cleanup = undefined;
        await flushScratchpad();
        expect(fake.store.saved).toBe('last words');
        expect(editor.disposed).toBe(true);
        expect(host.isConnected).toBe(false);
    });

    it('remembers the highlighting language', async () => {
        const host = render(<ScratchpadView visible editorTheme="t" fontFamily="mono" fontSize={14} wordWrap={false} onRegisterCommands={() => {}} />);
        await settle();
        const select = host.querySelector('select') as HTMLSelectElement;
        act(() => { select.value = 'sql'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(fake.created[0].model.language).toBe('sql');
        expect(localStorage.getItem('zitext_scratchpad_language')).toBe('sql');
    });

    it('writes saves in order, flushes on quit, and reports a failing disk once', async () => {
        fake.store.writeDelay = 30;
        scheduleScratchpadSave('one');
        const first = flushScratchpad();
        scheduleScratchpadSave('two');
        await flushScratchpadBeforeQuit();
        await first;
        expect(fake.store.writes).toEqual(['one', 'two']);
        expect(fake.store.saved).toBe('two');

        fake.store.writeDelay = 0;
        fake.store.failWrites = true;
        scheduleScratchpadSave('a');
        await flushScratchpad();
        scheduleScratchpadSave('b');
        await flushScratchpad();
        expect(fake.showError).toHaveBeenCalledTimes(1);
    });
});

describe('Scratchpad save problems', () => {
    it('keeps showing an unsaved banner, keeps the text when the view closes, and saves once possible', async () => {
        const view = <ScratchpadView visible editorTheme="t" fontFamily="mono" fontSize={14} wordWrap={false} onRegisterCommands={() => {}} />;
        let host = render(view);
        await settle();
        fake.store.failWrites = true;
        fake.created[0].model.type('6 MB of pasted log');
        await act(async () => { await new Promise(r => setTimeout(r, 500)); });
        expect(host.querySelector('.scratchpad-unsaved')?.textContent).toContain('disk full');

        // Closing and reopening the view keeps the text in memory.
        cleanup!();
        await act(async () => { await flushScratchpad(); });
        host = render(view);
        await settle();
        expect(fake.created[1].model.getValue()).toBe('6 MB of pasted log');

        // Once saving works again, the text is written and the banner goes.
        fake.store.failWrites = false;
        fake.created[1].model.type('trimmed');
        await act(async () => { await new Promise(r => setTimeout(r, 500)); });
        expect(fake.store.saved).toBe('trimmed');
        expect(host.querySelector('.scratchpad-unsaved')).toBeNull();
    });
});

describe('Scratchpad at quit', () => {
    it('says when a save is still running after the wait, instead of quitting as if saved', async () => {
        vi.useFakeTimers();
        fake.store.writeDelay = 5000;
        scheduleScratchpadSave('slow disk');
        const result = flushScratchpadBeforeQuit();
        await vi.advanceTimersByTimeAsync(2100);
        expect(await result).toBe('pending');
        await vi.advanceTimersByTimeAsync(5000);
        expect(await flushScratchpadBeforeQuit()).toBe('done');
        expect(fake.store.saved).toBe('slow disk');
    });
});

describe('input prompt', () => {
    it('does not submit on the Enter that confirms an input-method conversion', () => {
        const onSubmit = vi.fn();
        const host = render(<InputPrompt request={{ title: 'Mark Text', label: 'Mark', submitLabel: 'Mark', onSubmit }} onClose={() => {}} />);
        const input = host.querySelector('input') as HTMLInputElement;
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('submits with Enter, shows a problem, and cancels with Escape', async () => {
        const onSubmit = vi.fn((value: string) => (value ? undefined : 'Enter something.'));
        const onClose = vi.fn();
        const host = render(<InputPrompt request={{ title: 'Split Lines', label: 'Split at', submitLabel: 'Split', options: [{ key: 'trim', label: 'Trim' }], onSubmit }} onClose={onClose} />);
        const input = host.querySelector('input:not([type])') as HTMLInputElement;
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(host.textContent).toContain('Enter something.');
        expect(onClose).not.toHaveBeenCalled();

        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ';');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        });
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(onSubmit).toHaveBeenLastCalledWith(';', { trim: true });
        expect(onClose).toHaveBeenCalledTimes(1);

        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
