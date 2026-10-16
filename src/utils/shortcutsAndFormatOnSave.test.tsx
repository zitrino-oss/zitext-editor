// @vitest-environment jsdom
/**
 * Format on Save for untitled documents, the shortcut editor and recorder,
 * the shared shortcut registry, and the line count helper.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(async () => true) }));

import { shouldFormatOnSave } from './dataTransform';
import { KeybindingEditor } from '../components/KeybindingEditor';
import { fileWatcher } from './fileWatcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; invoke.mockReset(); fileWatcher.unwatchAll(); });

describe('Format on Save', () => {
    it('leaves untitled and read-only documents alone', () => {
        expect(shouldFormatOnSave({ path: '/p/a.json', isReadOnly: false }, true)).toBe(true);
        expect(shouldFormatOnSave({ path: null, isReadOnly: false }, true)).toBe(false);
        expect(shouldFormatOnSave({ path: '/p/a.json', isReadOnly: true }, true)).toBe(false);
        expect(shouldFormatOnSave({ path: '/p/a.json', isReadOnly: false }, false)).toBe(false);
    });
});

describe('Shortcut editor', () => {
    it('refuses a key that a fixed command already uses', () => {
        const onSave = vi.fn();
        const host = document.createElement('div');
        const root = createRoot(host);
        act(() => root.render(<KeybindingEditor isOpen onClose={() => {}} keybindings={{}} onSave={onSave} />));
        cleanup = () => act(() => root.unmount());
        const binding = host.querySelector('.kb-binding-btn') as HTMLButtonElement;
        act(() => binding.click());
        const capture = host.querySelector('.kb-capture') as HTMLElement;
        const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
        act(() => {
            capture.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'F', shiftKey: true, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true,
            }));
        });
        expect(host.querySelector('.kb-capture-error')?.textContent).toContain('Find in Files');
    });
});

describe('Shortcut recorder', () => {
    it('records the physical key for Option-composed and non-Latin characters', () => {
        const onSave = vi.fn();
        const host = document.createElement('div');
        const root = createRoot(host);
        act(() => root.render(<KeybindingEditor isOpen onClose={() => {}} keybindings={{}} onSave={onSave} />));
        cleanup = () => act(() => root.unmount());
        act(() => (host.querySelector('.kb-binding-btn') as HTMLButtonElement).click());
        const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
        act(() => {
            (host.querySelector('.kb-capture') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ƒ', code: 'KeyF', altKey: true, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true,
            }));
        });
        act(() => ([...host.querySelectorAll('button')].find(b => b.textContent === 'Done') as HTMLButtonElement).click());
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ new: `${isMac ? 'Cmd' : 'Ctrl'}+Alt+F` }));
    });
});

describe('One shortcut registry', () => {
    it('App, the shortcut editor and the menu read the same defaults', async () => {
        const { bindingFor, COMMANDS } = await import('./commandRegistry');
        const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
        expect(bindingFor('saveAs', {})).toEqual({ key: 's', ctrlOrCmd: true, shift: true, alt: false });
        expect(bindingFor('replace', {})).toEqual(isMac
            ? { key: 'f', ctrlOrCmd: true, shift: false, alt: true }
            : { key: 'h', ctrlOrCmd: true, shift: false, alt: false });
        expect(bindingFor('save', { save: 'Ctrl+Alt+S' })).toEqual({ key: 's', ctrlOrCmd: true, shift: false, alt: true });
        expect(() => bindingFor('nope', {})).toThrow();
        expect(new Set(COMMANDS.map(command => command.id)).size).toBe(COMMANDS.length);
    });
});

describe('Line count helper', () => {
    it('counts lines without splitting the document', async () => {
        const { countLines } = await import('./fileOperations');
        expect(countLines('')).toBe(1);
        expect(countLines('a\nb\n')).toBe(3);
        expect(countLines('a\r\nb')).toBe(2);
        expect(countLines('x\n'.repeat(100_000))).toBe(100_001);
    });
});
