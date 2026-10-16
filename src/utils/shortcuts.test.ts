// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { handleKeyDown, isBrowserNavigationKey, normalizeShortcutKey, parseBinding, sanitizeKeybindings } from './shortcuts';

describe('stored shortcut migration', () => {
    it('drops modifier-less printable bindings but keeps safe shortcuts', () => {
        expect(sanitizeKeybindings({
            save: 'S',
            insertSpace: 'Space',
            submit: 'Enter',
            move: 'ArrowUp',
            wrap: 'Alt+Z',
            open: 'Ctrl+O',
            help: 'F2',
            escape: 'Escape',
        })).toEqual({
            wrap: 'Alt+Z',
            open: 'Ctrl+O',
            help: 'F2',
            escape: 'Escape',
        });
    });

    it('normalizes the browser Space event to the stored key name', () => {
        expect(normalizeShortcutKey(' ')).toBe('space');
        expect(normalizeShortcutKey('Space')).toBe('space');
    });
});

// Browser reload/navigation keys must not reach the
// webview (WebView2 reloads the whole app on F5 / Ctrl+R).
describe('browser navigation keys', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

    it('recognises reload and history keys', () => {
        expect(isBrowserNavigationKey(key({ key: 'F5' }))).toBe(true);
        expect(isBrowserNavigationKey(key({ key: 'F5', ctrlKey: true }))).toBe(true);
        expect(isBrowserNavigationKey(key({ key: 'r', ctrlKey: true }))).toBe(true);
        expect(isBrowserNavigationKey(key({ key: 'R', ctrlKey: true, shiftKey: true }))).toBe(true);
        expect(isBrowserNavigationKey(key({ key: 'r', metaKey: true }))).toBe(true);
        expect(isBrowserNavigationKey(key({ key: 'BrowserBack' }))).toBe(true);
        expect(isBrowserNavigationKey(key({ key: 'BrowserRefresh' }))).toBe(true);
    });

    it('leaves ordinary typing and editing keys alone', () => {
        expect(isBrowserNavigationKey(key({ key: 'r' }))).toBe(false);
        expect(isBrowserNavigationKey(key({ key: 'R', shiftKey: true }))).toBe(false);
        expect(isBrowserNavigationKey(key({ key: 'r', ctrlKey: true, altKey: true }))).toBe(false); // AltGr
        expect(isBrowserNavigationKey(key({ key: 'ArrowLeft', altKey: true }))).toBe(false);
        expect(isBrowserNavigationKey(key({ key: 's', ctrlKey: true }))).toBe(false);
    });

    it('a user binding on Ctrl+R is still handled by the app first', () => {
        let ran = false;
        const event = key({ key: 'r', ctrlKey: true, metaKey: true, cancelable: true });
        const handled = handleKeyDown(event, [{ key: 'r', ctrlOrCmd: true, action: () => { ran = true; } }]);
        expect(handled).toBe(true);
        expect(ran).toBe(true);
    });
});

// Shortcuts on non-US keyboard layouts.
describe('keyboard layouts', () => {
    const run = (init: KeyboardEventInit, handler: Parameters<typeof handleKeyDown>[1][number]) => {
        let ran = false;
        const handled = handleKeyDown(new KeyboardEvent('keydown', { cancelable: true, ...init }), [
            { ...handler, action: () => { ran = true; } },
        ]);
        return handled && ran;
    };

    it('AltGr does not trigger Ctrl shortcuts (typing "\\" on German/French layouts)', () => {
        expect(run({ key: '\\', ctrlKey: true, altKey: true, metaKey: true }, { key: '\\', ctrlOrCmd: true, action: () => {} })).toBe(false);
        expect(run({ key: '\\', ctrlKey: true, metaKey: true }, { key: '\\', ctrlOrCmd: true, action: () => {} })).toBe(true);
    });

    it('matches letters by physical key on non-Latin layouts', () => {
        // Russian layout: Ctrl+S produces "ы".
        expect(run({ key: 'ы', code: 'KeyS', ctrlKey: true, metaKey: true }, { key: 's', ctrlOrCmd: true, action: () => {} })).toBe(true);
        // macOS Option+Z produces "Ω".
        expect(run({ key: 'Ω', code: 'KeyZ', altKey: true }, { key: 'z', ctrlOrCmd: false, alt: true, action: () => {} })).toBe(true);
    });

    it('explicit Alt bindings still require Alt', () => {
        expect(run({ key: 'z' }, { key: 'z', ctrlOrCmd: false, alt: true, action: () => {} })).toBe(false);
    });
});

describe('the + key in bindings', () => {
    it('reads "Plus" and the old "Ctrl++" as the + key', () => {
        expect(parseBinding('Ctrl+Plus')).toEqual({ key: '+', ctrlOrCmd: true, shift: false, alt: false });
        expect(parseBinding('Ctrl++').key).toBe('+');
    });

    it('fires Ctrl+Plus on the + key and never on plain typing', () => {
        let fired = 0;
        const handlers = [{ ...parseBinding('Ctrl+Plus'), action: () => { fired++; } }];
        handleKeyDown(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, metaKey: true }), handlers);
        expect(fired).toBe(1);
        handleKeyDown(new KeyboardEvent('keydown', { key: '+' }), handlers);
        expect(fired).toBe(1);
        expect(sanitizeKeybindings({ zoom: 'Plus' })).toEqual({});
    });
});
