// @vitest-environment jsdom
/**
 * Markdown preview links must not navigate the app webview, and document
 * content must not be able to reuse app selectors such as ".modal-overlay".
 * Uses the real marked + DOMPurify pipeline.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../services/ErrorService', () => ({ errorService: { showError: vi.fn() } }));

import { MarkdownPreview } from './MarkdownPreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; invoke.mockClear(); });

async function render(markdown: string, onOpenFile = vi.fn()) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(
        <MarkdownPreview content={markdown} documentPath="/project/README.md" onOpenFile={onOpenFile} />,
    ));
    const deadline = Date.now() + 2000;
    while (!host.querySelector('.markdown-body')?.innerHTML) {
        if (Date.now() > deadline) throw new Error('preview did not render');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    return { body: host.querySelector('.markdown-body') as HTMLElement, onOpenFile };
}

function click(element: Element, init: MouseEventInit = {}) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    act(() => { element.dispatchEvent(event); });
    return event;
}

describe('MarkdownPreview links', () => {
    it('never lets a link click navigate the webview', async () => {
        const { body, onOpenFile } = await render(
            '[guide](docs/guide.md) [site](https://example.com) [mail](mailto:a@b.c) [top](#intro) [bad](javascript:alert(1))',
        );
        for (const anchor of body.querySelectorAll('a')) {
            expect(click(anchor).defaultPrevented).toBe(true);
        }
        expect(onOpenFile).toHaveBeenCalledWith('/project/docs/guide.md');
        expect(invoke).toHaveBeenCalledWith('open_external_link', { url: 'https://example.com/' });
        expect(invoke).toHaveBeenCalledWith('open_external_link', { url: 'mailto:a@b.c' });
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('blocks middle-click on links too', async () => {
        const { body } = await render('[site](https://example.com)');
        const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
        act(() => { body.querySelector('a')!.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('scrolls to the matching heading for #anchors', async () => {
        const { body } = await render('[go](#getting-started)\n\n## Getting Started\n');
        const heading = body.querySelector('h2')!;
        heading.scrollIntoView = vi.fn();
        click(body.querySelector('a')!);
        expect(heading.scrollIntoView).toHaveBeenCalled();
    });
});

describe('MarkdownPreview sanitization', () => {
    it('strips app classes, ids, names and data attributes but keeps code language hints', async () => {
        const { body } = await render([
            '<div class="modal-overlay" id="editor-workspace" data-x="1"><div class="modal">',
            '<input type="password" name="getElementById"></div></div>',
            '',
            '```js',
            'let x = 1;',
            '```',
        ].join('\n'));
        expect(body.querySelector('.modal-overlay, .modal')).toBeNull();
        expect(body.querySelector('[id], [name], [data-x]')).toBeNull();
        expect(body.querySelector('code.language-js')).not.toBeNull();
    });
});

describe('Rendering while typing', () => {
    it('re-renders once typing pauses, not on every keystroke', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        const view = (markdown: string) => <MarkdownPreview content={markdown} documentPath="/project/README.md" />;
        act(() => root.render(view('# One')));
        cleanup = () => { act(() => root.unmount()); host.remove(); };
        const body = () => host.querySelector('.markdown-body')?.textContent ?? '';
        const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
        await wait(30);
        expect(body()).toContain('One'); // the first render is immediate

        act(() => root.render(view('# Two')));
        act(() => root.render(view('# Three')));
        await wait(30);
        expect(body()).toContain('One'); // still waiting for a pause
        await wait(250);
        expect(body()).toContain('Three');
    });
});
