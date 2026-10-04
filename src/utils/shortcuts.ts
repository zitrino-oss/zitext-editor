// Detect platform for keyboard shortcuts
// navigator.platform is deprecated; use userAgent instead
export const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);

// Windows is the only platform that runs undecorated (see tauri.windows.conf.json),
// so it is also the only one that draws its own titlebar and window buttons.
// macOS keeps the native chrome plus the AppKit menu; Linux keeps the WM's frame,
// where an undecorated window loses reliable edge-resize under several compositors.
export const isWindows = /Windows/i.test(navigator.userAgent);

export const modKey = isMac ? 'Cmd' : 'Ctrl';

export interface ShortcutHandler {
    key: string;
    ctrlOrCmd: boolean;
    shift?: boolean;
    alt?: boolean;
    action: () => void;
    /** Also stop the event reaching the editor.
     *
     *  preventDefault alone only cancels the browser's own action; the event
     *  still travels on to Monaco, which checks the keystroke itself rather
     *  than whether anyone has handled it. That is harmless for most bindings,
     *  but matters for any key Monaco treats as a chord prefix — Ctrl+K, which
     *  starts Ctrl+K Ctrl+C and friends. Without this the editor would quietly
     *  enter chord mode behind the folder dialog and eat the next keystroke. */
    stopPropagation?: boolean;
}

export function normalizeShortcutKey(key: string): string {
    return key === ' ' ? 'space' : key.toLowerCase();
}

const MODIFIER_REQUIRED_KEYS = new Set([
    'space', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    'home', 'end', 'pageup', 'pagedown',
]);

export function requiresShortcutModifier(key: string): boolean {
    const normalized = normalizeShortcutKey(key);
    return normalized.length === 1 || MODIFIER_REQUIRED_KEYS.has(normalized);
}

export function handleKeyDown(
    event: KeyboardEvent,
    handlers: ShortcutHandler[]
): boolean {
    for (const handler of handlers) {
        const modifierMatch = handler.ctrlOrCmd
            ? (isMac ? event.metaKey : event.ctrlKey)
            // When no Ctrl/Cmd modifier is expected, verify neither is held.
            // Without this check, e.g. Alt+Z would also fire on Ctrl+Alt+Z.
            : !(event.ctrlKey || event.metaKey);

        const shiftMatch = handler.shift !== undefined
            ? event.shiftKey === handler.shift
            : true;

        const altMatch = handler.alt !== undefined
            ? event.altKey === handler.alt
            : true;

        if (
            normalizeShortcutKey(event.key) === normalizeShortcutKey(handler.key) &&
            modifierMatch &&
            shiftMatch &&
            altMatch
        ) {
            event.preventDefault();
            if (handler.stopPropagation) event.stopPropagation();
            handler.action();
            return true;
        }
    }

    return false;
}

/**
 * Parse a stored binding string (e.g. "Ctrl+Shift+S" or "Cmd+N") into the
 * ShortcutHandler modifier fields. `ctrlOrCmd` is true whenever the binding
 * contains Ctrl or Cmd, so it works correctly on both platforms.
 */
export function parseBinding(binding: string): { key: string; ctrlOrCmd: boolean; shift: boolean; alt: boolean } {
    const parts = binding.split('+');
    let ctrlOrCmd = false;
    let shift = false;
    let alt = false;
    let key = '';

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'ctrl' || lower === 'cmd' || lower === 'meta') ctrlOrCmd = true;
        else if (lower === 'shift') shift = true;
        else if (lower === 'alt' || lower === 'option') alt = true;
        else key = part.toLowerCase();
    }

    return { key, ctrlOrCmd, shift, alt };
}

/** Drops legacy shortcuts that can fire while the user is simply typing. */
export function sanitizeKeybindings(
    bindings: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(Object.entries(bindings).filter(([, binding]) => {
        const parsed = parseBinding(binding);
        return !(requiresShortcutModifier(parsed.key) && !parsed.ctrlOrCmd && !parsed.alt);
    }));
}

export function getShortcutDisplay(key: string, ctrlOrCmd: boolean = true, shift: boolean = false): string {
    const parts: string[] = [];

    if (ctrlOrCmd) {
        parts.push(isMac ? '⌘' : 'Ctrl');
    }

    if (shift) {
        parts.push(isMac ? '⇧' : 'Shift');
    }

    parts.push(key.toUpperCase());

    return parts.join(isMac ? '' : '+');
}
