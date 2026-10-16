// Detect platform for keyboard shortcuts
// navigator.platform is deprecated; use userAgent instead
export const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);

// Windows is the only platform that runs undecorated (see tauri.windows.conf.json),
// so it is also the only one that draws its own titlebar and window buttons.
// macOS keeps the native chrome plus the AppKit menu; Linux keeps the WM's frame,
// where an undecorated window loses reliable edge-resize under several compositors.
export const isWindows = /Windows/i.test(navigator.userAgent);
export const isLinux = !isMac && !isWindows && /Linux/i.test(navigator.userAgent);

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
    if (key === ' ') return 'space';
    const lower = key.toLowerCase();
    // Bindings spell "+" as "Plus": "+" is also the separator ("Ctrl+Plus").
    return lower === 'plus' ? '+' : lower;
}

/**
 * The key a shortcut should match for this event. Normally `event.key`, but
 * when that is a non-ASCII character (a Cyrillic, Greek, Hebrew or Arabic
 * layout, or a macOS Option-composed character such as "Ω" for Option+Z) the
 * physical key from `event.code` is used for letters and digits, so Ctrl+S,
 * Alt+Z and friends work on every layout.
 */
export function shortcutKeyOf(event: KeyboardEvent): string {
    const key = normalizeShortcutKey(event.key);
    if (key.length === 1 && key.charCodeAt(0) > 0x7f) {
        const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code ?? '');
        if (physical) return (physical[1] ?? physical[2]).toLowerCase();
    }
    return key;
}

const MODIFIER_REQUIRED_KEYS = new Set([
    'space', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    'home', 'end', 'pageup', 'pagedown',
]);

export function requiresShortcutModifier(key: string): boolean {
    const normalized = normalizeShortcutKey(key);
    return normalized.length === 1 || MODIFIER_REQUIRED_KEYS.has(normalized);
}

/**
 * True while an input method (IME) is composing text (Chinese, Japanese,
 * Korean and others). The Enter that commits a composition must not also
 * trigger an action such as Replace or running a palette command.
 */
export function isImeComposing(event: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
    const native = 'nativeEvent' in event ? event.nativeEvent : event;
    return native.isComposing || native.keyCode === 229;
}

/**
 * Keys a browser engine treats as "reload" or "go back/forward". In the app
 * webview these would discard the whole editor state (WebView2 on Windows
 * honours F5 / Ctrl+R / Ctrl+Shift+R). The app never uses them unless the user
 * binds one to a command, so the caller blocks them only when no app shortcut
 * handled the event.
 */
export function isBrowserNavigationKey(event: KeyboardEvent): boolean {
    if (event.key === 'F5' || event.key === 'BrowserRefresh') return true;
    if (event.key === 'BrowserBack' || event.key === 'BrowserForward') return true;
    const mod = event.ctrlKey || event.metaKey;
    return mod && !event.altKey && (event.key === 'r' || event.key === 'R');
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

        // Alt must match exactly; a binding that doesn't mention Alt requires
        // it to be up. Treating "unspecified" as "either" let AltGr (reported
        // as Ctrl+Alt on Windows) trigger Ctrl shortcuts: typing "\" on a German
        // or French keyboard toggled split view and swallowed the character.
        const altMatch = event.altKey === (handler.alt ?? false)
            && !(handler.alt !== true && event.getModifierState?.('AltGraph'));

        if (
            shortcutKeyOf(event) === normalizeShortcutKey(handler.key) &&
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
        else if (part) key = normalizeShortcutKey(part);
    }
    // "Ctrl++", as older versions recorded it, splits into empty parts.
    if (!key && binding.endsWith('+')) key = '+';

    return { key, ctrlOrCmd, shift, alt };
}

/** Drops legacy shortcuts that can fire while the user is simply typing, and
 *  on macOS a stored Cmd+H for Replace (older versions saved it on Reset):
 *  Cmd+H now hides the app, and Replace defaults to Cmd+Option+F. */
export function sanitizeKeybindings(
    bindings: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(Object.entries(bindings).filter(([command, binding]) => {
        if (isMac && command === 'replace' && binding.toLowerCase() === 'cmd+h') return false;
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
