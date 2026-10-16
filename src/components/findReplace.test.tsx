// @vitest-environment jsdom
/**
 * Find/Replace regressions and the command palette's stale selection. The
 * bar runs against a real Monaco text model; only the editor view is a thin
 * stand-in.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    // Monaco's browser feature probes that jsdom does not implement.
    (document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => false;
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false, media: query, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
    Element.prototype.scrollIntoView ??= function scrollIntoView() {};
    // Monaco's clipboard service listens for clicks and writes via this API.
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: async () => {}, writeText: async () => {}, readText: async () => '' },
    });
    // Like the browser's, it takes ownership of the promises it is given (Monaco
    // cancels them later; unobserved they would surface as unhandled rejections).
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem ??= class ClipboardItem {
        constructor(items: Record<string, unknown>) {
            for (const value of Object.values(items)) Promise.resolve(value).catch(() => {});
        }
    };
});

import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { FindReplaceBar } from './FindReplaceBar';
import { CommandPalette } from './CommandPalette';
import { lastFindQuery, marksOf } from '../utils/marks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Minimal editor view over a real model: selection, edits, undo stops. */
function makeEditor(model: editor.ITextModel) {
    let selection = new monaco.Selection(1, 1, 1, 1);
    return {
        getModel: () => model,
        getSelection: () => selection,
        setSelection: (range: monaco.IRange) => {
            selection = new monaco.Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
        },
        revealRangeInCenter: () => {},
        focus: () => {},
        pushUndoStop: () => { model.pushStackElement(); return true; },
        executeEdits: (_source: string, edits: { range: monaco.IRange; text: string }[]) => {
            model.pushEditOperations([], edits.map(e => ({ range: e.range, text: e.text })), () => null);
            return true;
        },
        onDidChangeModelContent: (listener: () => void) => model.onDidChangeContent(listener),
        onDidChangeModel: () => ({ dispose() {} }),
    } as unknown as editor.IStandaloneCodeEditor;
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function renderBar(text: string) {
    const model = monaco.editor.createModel(text);
    const ed = makeEditor(model);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(
        <FindReplaceBar isOpen showReplace onClose={() => {}} getEditor={() => ed} />,
    ));
    cleanup = () => { act(() => root.unmount()); host.remove(); model.dispose(); };
    const inputs = host.querySelectorAll<HTMLInputElement>('input.fr-input');
    return { host, model, ed, find: inputs[0], replace: inputs[1] };
}

function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
function press(target: Element, init: KeyboardEventInit) {
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
}
function clickButton(host: Element, title: string) {
    act(() => (host.querySelector(`button[title="${title}"]`) as HTMLButtonElement).click());
}
const count = (host: Element) => host.querySelector('.fr-count')?.textContent;

describe('Find/Replace', () => {
    it('replaces the text where the match is now, not a stale range', () => {
        const { host, model, find, replace } = renderBar('foo bar foo');
        type(find, 'foo');
        type(replace, 'baz');
        // The document changes underneath the open bar (e.g. typing elsewhere).
        act(() => { model.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: 'XX' }], () => null); });

        clickButton(host, 'Replace'); // selection is no longer a match: selects it
        clickButton(host, 'Replace'); // now replaces it
        expect(model.getValue()).toBe('XXbaz bar foo');
    });

    it('Mark keeps every match highlighted, and the palette can mark the same search', async () => {
        const { host, model, find } = renderBar('ERROR one\nok\nERROR two');
        type(find, 'ERROR');
        expect(lastFindQuery()).toEqual({ text: 'ERROR', regex: false, caseSensitive: false, wholeWord: false });
        const mark = host.querySelector('button[title^="Keep every match highlighted"]') as HTMLButtonElement;
        await act(async () => { mark.click(); });
        expect(marksOf(model).map(m => [m.text, m.count])).toEqual([['ERROR', 2]]);
        expect(model.getAllDecorations().filter(d => d.options.inlineClassName?.includes('zitext-mark-1'))).toHaveLength(2);
    });

    it('searches a Markdown preview that is still loading when Find opens', async () => {
        let body: HTMLElement | null = null;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => root.render(
            <FindReplaceBar isOpen showReplace={false} onClose={() => {}} getEditor={() => null} getPreviewElement={() => body} previewActive />,
        ));
        type(host.querySelector('input') as HTMLInputElement, 'hello');
        expect(host.textContent).toContain('0 of 0');
        // The preview arrives a moment later (it loads on first use).
        body = document.createElement('div');
        body.textContent = 'hello world, hello';
        document.body.appendChild(body);
        await act(async () => { await new Promise(r => setTimeout(r, 150)); });
        expect(host.textContent).toContain('of 2');
        act(() => root.unmount());
        host.remove();
        body.remove();
    });

    it('Enter in the Replace field replaces one match per press, skipping none', () => {
        const { model, find, replace } = renderBar('A1 A2 A3 A4');
        type(find, 'A');
        type(replace, 'B');
        press(replace, { key: 'Enter' });
        press(replace, { key: 'Enter' });
        expect(model.getValue()).toBe('B1 B2 A3 A4');
    });

    it('does not act on the Enter that commits an IME composition', () => {
        const { model, find, replace } = renderBar('A1 A2');
        type(find, 'A');
        type(replace, 'B');
        press(replace, { key: 'Enter', isComposing: true });
        expect(model.getValue()).toBe('A1 A2');
    });

    it('whole word treats "_" as part of a word', () => {
        const { host, find } = renderBar('user user_id my_user username');
        clickButton(host, 'Whole Word');
        type(find, 'user');
        expect(count(host)).toBe('1 of 1');
    });

    it('regex Replace All expands capture groups as one undo step', () => {
        const { host, model, find, replace } = renderBar('john@example and jane@test');
        clickButton(host, 'Regex');
        type(find, '(\\w+)@(\\w+)');
        type(replace, '$2:$1');
        // Typing just before, still open in the same undo group.
        act(() => { model.pushEditOperations([], [{ range: new monaco.Range(1, 27, 1, 27), text: '!' }], () => null); });
        clickButton(host, 'Replace All');
        expect(model.getValue()).toBe('example:john and test:jane!');
        // One undo takes back the whole Replace All, and only that.
        act(() => { model.undo(); });
        expect(model.getValue()).toBe('john@example and jane@test!');
    });
});

describe('Command palette', () => {
    function renderPalette() {
        const ran: string[] = [];
        const commands = ['Save', 'Save As', 'Open File', 'Close Tab', 'New File'].map(label => ({
            id: label, label, description: '', category: 'File', action: () => ran.push(label),
        }));
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => root.render(<CommandPalette isOpen onClose={() => {}} commands={commands} />));
        cleanup = () => { act(() => root.unmount()); host.remove(); };
        return { input: host.querySelector('input') as HTMLInputElement, ran };
    }

    it('typing a new query selects its first result', () => {
        const { input, ran } = renderPalette();
        for (let i = 0; i < 4; i++) press(input, { key: 'ArrowDown' });
        type(input, 'save');
        press(input, { key: 'Enter' });
        expect(ran).toEqual(['Save']);
    });

    it('opens with a starting query, such as the language picker from the status bar', () => {
        const ran: string[] = [];
        const commands = [
            { id: 'save', label: 'Save', description: '', category: 'File', action: () => ran.push('save') },
            { id: 'language-python', label: 'Change Language Mode: Python', description: '', category: 'Language', action: () => ran.push('python') },
        ];
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => root.render(<CommandPalette isOpen initialQuery="Change Language Mode: " onClose={() => {}} commands={[
            ...commands,
            { id: 'language-go', label: 'Change Language Mode: Go', description: '', category: 'Language', action: () => ran.push('go') },
        ]} />));
        cleanup = () => { act(() => root.unmount()); host.remove(); };
        const input = host.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('Change Language Mode: ');
        // Typing after the seeded text narrows the list (it used to empty it).
        type(input, 'Change Language Mode: py');
        press(input, { key: 'Enter' });
        expect(ran).toEqual(['python']);
    });

    it('ignores the Enter that commits an IME composition', () => {
        const { input, ran } = renderPalette();
        press(input, { key: 'Enter', isComposing: true });
        expect(ran).toEqual([]);
    });
});
