// @vitest-environment jsdom
/**
 * Small UI details: status-bar size in bytes, a
 * breadcrumb that no longer looks clickable, the font-size slider range,
 * recording Ctrl+Plus, preview only for Markdown, and the window title.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

import { StatusBar } from './StatusBar';
import { Breadcrumb } from './Breadcrumb';
import { SettingsModal } from './SettingsModal';
import { KeybindingEditor } from './KeybindingEditor';
import { useTabManager } from '../state/useTabManager';
import { MAX_FONT_SIZE } from '../constants';
import { windowCaption } from '../utils/windowTitle';
import { showsPreview } from '../utils/languages';
import type { Settings, Tab } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); });

function render(node: React.ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(node));
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    return host;
}

const statusBar = (content: string, encoding = 'UTF-8') => (
    <StatusBar tabId="t" line={1} column={1} language="plaintext" encoding={encoding} eol="LF"
        content={content} fontSize={14} showMinimap={false}
        onZoomIn={() => {}} onZoomOut={() => {}} onToggleMinimap={() => {}} />
);

describe('status bar file size', () => {
    it('counts the bytes the file takes on disk, not UTF-16 units', () => {
        vi.useFakeTimers();
        // 3 ASCII + "é" (2 bytes) + an emoji (4 bytes) = 9 bytes, 6 UTF-16 units.
        const host = render(statusBar('abcé😀'));
        act(() => { vi.advanceTimersByTime(300); });
        expect(host.querySelector('[title="File Size"]')?.textContent).toBe('9 B');
    });

    it('follows the encoding: one byte per character in Windows-1252, plus the BOM', () => {
        vi.useFakeTimers();
        let host = render(statusBar('abcé', 'Windows-1252'));
        act(() => { vi.advanceTimersByTime(300); });
        expect(host.querySelector('[title="File Size"]')?.textContent).toBe('4 B');
        cleanup?.();
        host = render(statusBar('abcé', 'UTF-8 with BOM'));
        act(() => { vi.advanceTimersByTime(300); });
        expect(host.querySelector('[title="File Size"]')?.textContent).toBe('8 B');
    });
});

describe('breadcrumb', () => {
    it('shows the file name as plain text, with nothing to click', () => {
        const host = render(<Breadcrumb path="/work/src/app.ts" lineCount={3} />);
        const name = host.querySelector('.breadcrumb-item-active') as HTMLElement;
        expect(name.textContent).toBe('app.ts');
        expect(name.onclick).toBeNull();
        expect(name.getAttribute('role')).toBeNull();
    });
});

describe('font size setting', () => {
    it('goes as high as zoom does', () => {
        const host = render(<SettingsModal isOpen onClose={() => {}} onSave={() => {}}
            settings={{ fontSize: 40, theme: 'dark', keybindings: {} } as unknown as Settings} />);
        const slider = host.querySelector('input[type="range"]') as HTMLInputElement;
        expect(Number(slider.max)).toBe(MAX_FONT_SIZE);
        expect(slider.value).toBe('40');
    });
});

describe('recording a shortcut with the + key', () => {
    it('stores "Plus", which parses back to the + key', () => {
        const onSave = vi.fn();
        const host = render(<KeybindingEditor isOpen onClose={() => {}} keybindings={{}} onSave={onSave} />);
        act(() => { (host.querySelector('.kb-binding-btn') as HTMLButtonElement).click(); });
        const capture = host.querySelector('.kb-capture') as HTMLInputElement;
        act(() => {
            capture.dispatchEvent(new KeyboardEvent('keydown', { key: '+', code: 'Equal', ctrlKey: true, metaKey: true, bubbles: true }));
        });
        const pills = [...host.querySelectorAll('.kb-row')[0].querySelectorAll('.kb-key')].map(k => k.textContent);
        expect(pills[pills.length - 1]).toBe('Plus');
    });
});

describe('Markdown preview', () => {
    function Harness({ language, api }: { language: string; api: { current: ReturnType<typeof useTabManager> | null } }) {
        const manager = useTabManager();
        api.current = manager;
        return <span data-preview={String(manager.tabs[0]?.isPreview ?? '')} data-language={language} />;
    }

    const tab = (id: string, language: string): Tab => ({
        id, path: `/p/${id}`, title: id, content: '', revision: 0, cursorLine: 1, cursorColumn: 1,
        isDirty: false, language, isReadOnly: false, encoding: 'UTF-8', diskVersion: null, eol: 'LF',
        scrollTop: 0, scrollLeft: 0, isUntitled: false, externallyModified: false, externalChangeCount: 0, isPreview: false,
    } as unknown as Tab);

    it.each([
        ['typescript', false],
        ['markdown', true],
        ['mdx', true],
    ])('toggling on a %s file turns preview on: %s', (language, expected) => {
        const api = { current: null as ReturnType<typeof useTabManager> | null };
        const host = render(<Harness language={language} api={api} />);
        act(() => api.current!.addTab(tab('a', language)));
        act(() => api.current!.togglePreview('a'));
        expect(host.querySelector('span')!.getAttribute('data-preview')).toBe(String(expected));
    });
});

describe('a preview left on from an older session', () => {
    it('shows the editor for anything but Markdown', () => {
        expect(showsPreview({ isPreview: true, language: 'typescript' })).toBe(false);
        expect(showsPreview({ isPreview: true, language: 'markdown' })).toBe(true);
        expect(showsPreview({ isPreview: false, language: 'markdown' })).toBe(false);
    });
});

describe('window title', () => {
    it('names an unsaved tab as the tab bar does', () => {
        expect(windowCaption({ path: null, title: 'Untitled-3' }, null)).toBe('Untitled-3');
        expect(windowCaption({ path: null, title: 'Untitled-3' }, '/work/site')).toBe('Untitled-3 — site');
        expect(windowCaption({ path: '/work/site/a.md', title: 'a.md' }, '/work/site')).toBe('a.md — site');
        expect(windowCaption(null, '/work/site')).toBe('site');
        expect(windowCaption(null, null)).toBe('ZITEXT Editor');
    });
});
