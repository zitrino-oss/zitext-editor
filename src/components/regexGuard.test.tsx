// @vitest-environment jsdom
/**
 * Slow regular expressions are refused instead of freezing the window.
 * The background check is mocked; the bar and the text model
 * are real.
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

const guard = vi.hoisted(() => ({ verdict: 'slow' as 'ok' | 'slow', checks: 0 }));
vi.mock('../utils/heavyTasks', () => ({
    regexGuardAvailable: () => true,
    checkRegexSpeed: async () => { guard.checks++; return guard.verdict; },
}));

import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { FindReplaceBar } from './FindReplaceBar';

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
function clickButton(host: Element, title: string) {
    act(() => (host.querySelector(`button[title="${title}"]`) as HTMLButtonElement).click());
}
const count = (host: Element) => host.querySelector('.fr-count')?.textContent;

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

describe('Regular expressions in Find', () => {
    it('a pattern too slow for the document is not run, and the bar says so', async () => {
        guard.verdict = 'slow';
        const { host, model, find, replace } = renderBar('aaaaaaaaaaaaaaaaaaaaaaaaaaaab');
        clickButton(host, 'Regex');
        type(find, '(a+)+$');
        await settle();
        expect(count(host)).toBe('Too slow');
        type(replace, 'x');
        clickButton(host, 'Replace All');
        expect(model.getValue()).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaab');
    });

    it('a pattern that finishes is searched once checked, and checked only once', async () => {
        guard.verdict = 'ok';
        guard.checks = 0;
        const { host, find } = renderBar('one two one');
        clickButton(host, 'Regex');
        type(find, 'o\\w+');
        await settle();
        expect(count(host)).toBe('1 of 2');
        clickButton(host, 'Match Case');
        clickButton(host, 'Match Case');
        await settle();
        expect(guard.checks).toBe(2); // one per pattern + case setting
    });
});
