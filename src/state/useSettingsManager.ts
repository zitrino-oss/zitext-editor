import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../types';
import { DEFAULT_FONT_SIZE, SIDEBAR_DEFAULT_WIDTH } from '../constants';
import { sanitizeKeybindings } from '../utils/shortcuts';
import { resolveTheme } from '../utils/theme';
import { reportPersistenceFailure } from '../utils/persistenceErrors';

/** Font stacks that used to be the defaults. A settings file still holding
 *  one of these has never had the font changed deliberately, so it is moved
 *  to the new default; any other value is the user's own pick and is kept. */
export const SUPERSEDED_DEFAULTS: Record<'fontFamily' | 'uiFont', string[]> = {
    fontFamily: [
        '"Menlo", "Consolas", "JetBrains Mono", monospace',
        '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
    ],
    uiFont: ['"IBM Plex Sans", "Segoe UI", Arial, sans-serif'],
};

/** Default settings for the editor. Must match `AppSettings::default()` in
 *  src-tauri/src/lib.rs — a mismatch causes the chrome and editor to render
 *  with different themes during the brief window before backend load. */
const DEFAULT_SETTINGS: Settings = {
    // Appearance, recent files, and last session
    theme: 'dark',
    fontFamily: '"JetBrains Mono", "Menlo", "Monaco", "Consolas", monospace',
    uiFont: '"Space Grotesk", system-ui, sans-serif',
    fontSize: DEFAULT_FONT_SIZE,
    wordWrap: false,
    recentFiles: [],
    lastSession: [],

    // Autosave, layout, and editor behavior
    autosave: 'off',
    autosaveDelay: 2000,
    showMinimap: false,
    editorTheme: 'vs-dark',
    keybindings: {},
    openedFolder: null,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    sidebarCollapsed: false,
    activeTabPath: null,
    enableColumnSelection: false,

    // Indentation and formatting
    tabSize: 4,
    insertSpaces: true,
    formatOnSave: false,

    // Updates
    checkForUpdates: true,
};

/** Forces the editor (Monaco) theme to agree with the app theme: a dark app
 *  theme pairs with a dark editor theme and vice versa. Guards against a
 *  settings file whose `theme` and `editorTheme` disagree. */
function syncEditorThemeToAppTheme(s: Settings): Settings {
    // The editor theme is no longer chosen separately — one app theme drives
    // both. Pinning it to the exact derived value also migrates settings files
    // left holding the removed high-contrast options.
    // Resolve first so 'system' still picks a concrete side.
    const editorTheme = resolveTheme(s.theme) === 'dark' ? 'vs-dark' : 'vs';
    return s.editorTheme === editorTheme ? s : { ...s, editorTheme };
}

/**
 * useSettingsManager - Manages application settings
 * 
 * Handles loading, saving, and updating user preferences.
 * Separated from useEditorState for better modularity.
 */
export function useSettingsManager() {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [isLoading, setIsLoading] = useState(true);

    // Mirrors the latest settings synchronously. updateSettings reads and
    // advances this so a burst of calls (e.g. font-size key-repeat, or theme +
    // editorTheme toggled together) compound instead of each starting from the
    // same stale `settings` closure and overwriting one another.
    // While updates are being written the ref runs ahead of the rendered
    // settings; syncing it from render then would drop those updates (and a
    // failed one could not be taken back), so it syncs only when none are.
    const settingsRef = useRef(settings);
    const pendingWrites = useRef(0);
    if (pendingWrites.current === 0) settingsRef.current = settings;

    /**
     * Load settings from disk
     */
    const loadSettings = useCallback(async (): Promise<Settings> => {
        try {
            // First-run signal: read_settings returns AppSettings::default()
            // (theme "dark") for a missing file, so it can't tell "no file yet"
            // from "saved all-dark". Check explicitly before loading.
            const fileExists = await invoke<boolean>('settings_file_exists');

            const loadedSettings = await invoke<Settings>('read_settings');
            const merged = { ...DEFAULT_SETTINGS, ...loadedSettings };
            // Migrate legacy theme ID: 'vs-light' was never a valid Monaco theme.
            if (merged.editorTheme === 'vs-light') {
                merged.editorTheme = merged.theme === 'dark' ? 'vs-dark' : 'vs';
            }
            // Migrate removed fonts: Anonymous Pro and Inconsolata were dropped
            // from FONT_FAMILIES and fonts.css. A stale saved stack would silently
            // render its Courier New fallback while the Settings dropdown shows blank.
            if (/Anonymous Pro|Inconsolata/.test(merged.fontFamily)) {
                merged.fontFamily = DEFAULT_SETTINGS.fontFamily;
            }
            for (const key of ['fontFamily', 'uiFont'] as const) {
                if (SUPERSEDED_DEFAULTS[key].includes(merged[key])) merged[key] = DEFAULT_SETTINGS[key];
            }
            merged.keybindings = sanitizeKeybindings(merged.keybindings);
            // Force agreement between app theme and editor theme so a stale
            // settings file can't leave us with dark chrome + light editor.
            const corrected = syncEditorThemeToAppTheme(merged);

            // Fresh install: no saved preference yet, so follow the OS light/dark
            // theme rather than the hard-coded dark default. Persist it
            // immediately (awaited) — initializeEditor awaits loadSettings before
            // opening any files, so this write lands before add_recent_file or
            // save_session could otherwise materialize settings.json with dark.
            if (!fileExists) {
                let osDark = true; // fall back to dark if matchMedia is unavailable
                try {
                    if (window.matchMedia) {
                        osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    }
                } catch { /* keep dark fallback */ }
                const firstRun: Settings = {
                    ...corrected,
                    theme: osDark ? 'dark' : 'light',
                    editorTheme: osDark ? 'vs-dark' : 'vs',
                };
                try {
                    await invoke('write_settings', { settings: firstRun });
                } catch (e) {
                    reportPersistenceFailure('settings', e);
                }
                setSettings(firstRun);
                setIsLoading(false);
                return firstRun;
            }

            setSettings(corrected);
            setIsLoading(false);
            return corrected;
        } catch {
            setIsLoading(false);
            return DEFAULT_SETTINGS;
        }
    }, []);

    /**
     * Save settings to disk
     */
    const saveSettings = useCallback(async (newSettings: Settings): Promise<boolean> => {
        try {
            await invoke('write_settings', { settings: newSettings });
            setSettings(newSettings);
            return true;
        } catch (error) {
            reportPersistenceFailure('settings', error);
            return false;
        }
    }, []);

    /**
     * Update specific settings
     */
    const updateSettings = useCallback(async (updates: Partial<Settings>): Promise<void> => {
        if (Object.prototype.hasOwnProperty.call(updates, 'openedFolder')) {
            try {
                await invoke('set_opened_folder', { path: updates.openedFolder ?? null });
            } catch (error) {
                console.error('Failed to persist opened folder:', error);
                return;
            }
        }

        const previous = settingsRef.current;
        const updated = { ...previous, ...updates };
        // Advance the ref synchronously so a second call in the same tick merges
        // onto this result rather than the pre-update value.
        settingsRef.current = updated;
        pendingWrites.current += 1;
        const saved = await saveSettings(updated).finally(() => { pendingWrites.current -= 1; });
        if (saved) return;
        // The write failed: take this change back out of the ref, so the next
        // successful write doesn't persist it behind the user's back. Keys a
        // later update has changed since are left to that update.
        const rolledBack = { ...settingsRef.current };
        for (const key of Object.keys(updates) as (keyof Settings)[]) {
            if (rolledBack[key] === updated[key]) {
                (rolledBack as Record<keyof Settings, unknown>)[key] = previous[key];
            }
        }
        settingsRef.current = rolledBack;
    }, [saveSettings]);

    return {
        settings,
        isLoading,
        loadSettings,
        saveSettings,
        updateSettings,
    };
}
