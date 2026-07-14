// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeShortcutKey, sanitizeKeybindings } from './shortcuts';

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
