/**
 * Platform config overrides. Tauri merges platform files as a
 * JSON merge patch, which replaces arrays whole: a Windows override listing
 * only `decorations` left the window at 800×600 titled "Tauri App".
 */
import { describe, expect, it } from 'vitest';
import baseConfig from '../src-tauri/tauri.conf.json';
import windowsConfig from '../src-tauri/tauri.windows.conf.json';

describe('tauri.windows.conf.json', () => {
    it('repeats every window setting from tauri.conf.json', () => {
        const base: Record<string, unknown>[] = baseConfig.app.windows;
        const windows: Record<string, unknown>[] = windowsConfig.app.windows;
        expect(windows).toHaveLength(base.length);
        base.forEach((window, index) => {
            expect(windows[index]).toMatchObject(window);
        });
    });
});
