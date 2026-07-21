import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../types';
import { DEFAULT_FONT_SIZE, SIDEBAR_DEFAULT_WIDTH } from '../constants';
import { sanitizeKeybindings } from '../utils/shortcuts';

/** Default settings for the editor. Must match `AppSettings::default()` in
 *  src-tauri/src/lib.rs — a mismatch causes the chrome and editor to render
 *  with different themes during the brief window before backend load. */
const DEFAULT_SETTINGS: Settings = {
    // Appearance, recent files, and last session
    theme: 'dark',
    fontFamily: '"Menlo", "Consolas", "JetBrains Mono", monospace',
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
    sortJsonKeys: false,
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

/** Editor themes that pair with the dark app theme. Anything else (vs, hc-light) is light. */
const DARK_EDITOR_THEMES = new Set(['vs-dark', 'hc-black']);

/** Forces the editor (Monaco) theme to agree with the app theme: a dark app
 *  theme pairs with a dark editor theme and vice versa. Guards against a
 *  settings file whose `theme` and `editorTheme` disagree. */
function syncEditorThemeToAppTheme(s: Settings): Settings {
    const editorIsDark = DARK_EDITOR_THEMES.has(s.editorTheme);
    if (s.theme === 'dark' && !editorIsDark) {
        return { ...s, editorTheme: 'vs-dark' };
    }
    if (s.theme === 'light' && editorIsDark) {
        return { ...s, editorTheme: 'vs' };
    }
    return s;
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
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

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
                    console.error('Failed to persist first-run theme:', e);
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
    const saveSettings = useCallback(async (newSettings: Settings): Promise<void> => {
        try {
            await invoke('write_settings', { settings: newSettings });
            setSettings(newSettings);
        } catch (error) {
            console.error('Failed to save settings:', error);
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

        const updated = { ...settingsRef.current, ...updates };
        // Advance the ref synchronously so a second call in the same tick merges
        // onto this result rather than the pre-update value.
        settingsRef.current = updated;
        await saveSettings(updated);
    }, [saveSettings]);

    return {
        settings,
        isLoading,
        loadSettings,
        saveSettings,
        updateSettings,
    };
}
