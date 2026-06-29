import type { KeybindingConfig } from '../types';

/**
 * Default keybindings for the editor
 */
export const DEFAULT_KEYBINDINGS: KeybindingConfig[] = [
    {
        command: 'newFile',
        key: 'Mod+N',
        label: 'New File',
        defaultKey: 'Mod+N',
    },
    {
        command: 'openFile',
        key: 'Mod+O',
        label: 'Open File',
        defaultKey: 'Mod+O',
    },
    {
        command: 'save',
        key: 'Mod+S',
        label: 'Save',
        defaultKey: 'Mod+S',
    },
    {
        command: 'saveAs',
        key: 'Mod+Shift+S',
        label: 'Save As',
        defaultKey: 'Mod+Shift+S',
    },
    {
        command: 'closeTab',
        key: 'Mod+W',
        label: 'Close Tab',
        defaultKey: 'Mod+W',
    },
    {
        command: 'find',
        key: 'Mod+F',
        label: 'Find',
        defaultKey: 'Mod+F',
    },
    {
        command: 'replace',
        key: 'Mod+H',
        label: 'Find & Replace',
        defaultKey: 'Mod+H',
    },
    {
        command: 'goToLine',
        key: 'Mod+G',
        label: 'Go to Line',
        defaultKey: 'Mod+G',
    },
    {
        command: 'commentLine',
        key: 'Mod+/',
        label: 'Toggle Line Comment',
        defaultKey: 'Mod+/',
    },
    {
        command: 'commentBlock',
        key: 'Mod+Shift+/',
        label: 'Toggle Block Comment',
        defaultKey: 'Mod+Shift+/',
    },
    {
        command: 'formatDocument',
        key: 'Mod+Shift+F',
        label: 'Format Document',
        defaultKey: 'Mod+Shift+F',
    },
    {
        command: 'increaseFontSize',
        key: 'Mod+=',
        label: 'Increase Font Size',
        defaultKey: 'Mod+=',
    },
    {
        command: 'decreaseFontSize',
        key: 'Mod+-',
        label: 'Decrease Font Size',
        defaultKey: 'Mod+-',
    },
];

/**
 * Convert "Mod" to platform-specific modifier
 */
export function normalizeKey(key: string): string {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    return key.replace('Mod', isMac ? 'Cmd' : 'Ctrl');
}

/**
 * Parse key combination into components
 */
export function parseKeyCombination(key: string): {
    ctrl: boolean;
    cmd: boolean;
    shift: boolean;
    alt: boolean;
    key: string;
} {
    const parts = key.split('+');
    const result = {
        ctrl: false,
        cmd: false,
        shift: false,
        alt: false,
        key: '',
    };

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'ctrl') result.ctrl = true;
        else if (lower === 'cmd' || lower === 'meta') result.cmd = true;
        else if (lower === 'shift') result.shift = true;
        else if (lower === 'alt' || lower === 'option') result.alt = true;
        else result.key = part;
    }

    return result;
}

/**
 * Check if a keyboard event matches a key combination
 */
export function matchesKeyCombination(event: KeyboardEvent, keyCombination: string): boolean {
    const normalized = normalizeKey(keyCombination);
    const parsed = parseKeyCombination(normalized);

    // Check modifiers
    if (parsed.ctrl && !event.ctrlKey) return false;
    if (parsed.cmd && !event.metaKey) return false;
    if (parsed.shift && !event.shiftKey) return false;
    if (parsed.alt && !event.altKey) return false;

    // Check key
    const eventKey = event.key.toLowerCase();
    const targetKey = parsed.key.toLowerCase();

    // Handle special cases
    if (targetKey === '=' && (eventKey === '=' || eventKey === '+')) return true;
    if (targetKey === '-' && (eventKey === '-' || eventKey === '_')) return true;

    return eventKey === targetKey;
}

/**
 * Get display string for key combination
 */
export function getKeyDisplayString(key: string): string {
    const normalized = normalizeKey(key);
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    return normalized
        .replace('Cmd', isMac ? '⌘' : 'Ctrl')
        .replace('Ctrl', isMac ? '⌃' : 'Ctrl')
        .replace('Shift', isMac ? '⇧' : 'Shift')
        .replace('Alt', isMac ? '⌥' : 'Alt')
        .replace('Option', '⌥')
        .replace('+', isMac ? '' : '+');
}

/**
 * Validate key combination format
 */
export function isValidKeyCombination(key: string): boolean {
    if (!key || key.trim() === '') return false;

    const parts = key.split('+');
    if (parts.length === 0) return false;

    // Must have at least one modifier and one key
    const modifiers = ['Ctrl', 'Cmd', 'Mod', 'Shift', 'Alt', 'Option', 'Meta'];
    const hasModifier = parts.some(part => modifiers.includes(part));
    const hasKey = parts.some(part => !modifiers.includes(part) && part.length > 0);

    return hasModifier && hasKey;
}

/**
 * Check for keybinding conflicts
 */
export function findKeybindingConflicts(
    keybindings: KeybindingConfig[]
): Map<string, string[]> {
    const conflicts = new Map<string, string[]>();

    for (let i = 0; i < keybindings.length; i++) {
        for (let j = i + 1; j < keybindings.length; j++) {
            const a = keybindings[i];
            const b = keybindings[j];

            if (normalizeKey(a.key) === normalizeKey(b.key)) {
                const key = normalizeKey(a.key);
                if (!conflicts.has(key)) {
                    conflicts.set(key, []);
                }
                conflicts.get(key)!.push(a.command, b.command);
            }
        }
    }

    return conflicts;
}

/**
 * Load keybindings from settings
 */
export function loadKeybindings(customBindings: Record<string, string>): KeybindingConfig[] {
    return DEFAULT_KEYBINDINGS.map(binding => ({
        ...binding,
        key: customBindings[binding.command] || binding.defaultKey,
    }));
}

/**
 * Save keybindings to settings format
 */
export function saveKeybindings(keybindings: KeybindingConfig[]): Record<string, string> {
    const result: Record<string, string> = {};

    for (const binding of keybindings) {
        if (binding.key !== binding.defaultKey) {
            result[binding.command] = binding.key;
        }
    }

    return result;
}
