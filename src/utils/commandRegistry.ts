/**
 * The one list of keyboard commands. The shortcut editor shows
 * and records these, App binds them, and the native macOS menu takes its key
 * equivalents from the same bindings (see build_app_menu in lib.rs), so a
 * custom shortcut is the same everywhere.
 */
import { isMac, parseBinding } from './shortcuts';

export { isMac };
/** "Cmd" on macOS, "Ctrl" elsewhere, as bindings are written and shown. */
export const mod = isMac ? 'Cmd' : 'Ctrl';

export interface CommandDef {
    id: string;
    label: string;
    defaultKey: string;
}

export const COMMANDS: CommandDef[] = [
    { id: 'new', label: 'New File', defaultKey: `${mod}+N` },
    { id: 'open', label: 'Open File', defaultKey: `${mod}+O` },
    { id: 'openFolder', label: 'Open Folder', defaultKey: `${mod}+K` },
    { id: 'save', label: 'Save', defaultKey: `${mod}+S` },
    { id: 'saveAs', label: 'Save As', defaultKey: `${mod}+Shift+S` },
    { id: 'close', label: 'Close Tab', defaultKey: `${mod}+W` },
    { id: 'find', label: 'Find', defaultKey: `${mod}+F` },
    // Cmd+H hides the app on macOS.
    { id: 'replace', label: 'Find & Replace', defaultKey: isMac ? 'Cmd+Alt+F' : 'Ctrl+H' },
    { id: 'goToLine', label: 'Go to Line', defaultKey: `${mod}+G` },
    { id: 'commandPalette', label: 'Command Palette', defaultKey: `${mod}+Shift+P` },
    { id: 'wordWrap', label: 'Toggle Word Wrap', defaultKey: 'Alt+Z' },
    { id: 'scratchpad', label: 'Open Scratchpad', defaultKey: `${mod}+Shift+N` },
    { id: 'markSelection', label: 'Mark Selection', defaultKey: `${mod}+Shift+M` },
    { id: 'nextMark', label: 'Next Marked Occurrence', defaultKey: 'F4' },
    { id: 'previousMark', label: 'Previous Marked Occurrence', defaultKey: 'Shift+F4' },
];

/**
 * Shortcuts that can't be changed here (app, editor and system keys). A
 * custom binding may not take one of them: whichever handler ran first used
 * to win, silently.
 */
export const FIXED_SHORTCUTS: Record<string, string> = {
    [`${mod}+Shift+F`]: 'Find in Files',
    [`${mod}+Shift+V`]: 'Markdown Preview',
    [`${mod}+\\`]: 'Split View',
    [`${mod}+=`]: 'Zoom In',
    [`${mod}+-`]: 'Zoom Out',
    [`${mod}+,`]: 'Settings',
    [`${mod}+P`]: 'Command Palette',
    [`${mod}+Q`]: 'Quit',
    [`${mod}+Z`]: 'Undo',
    [`${mod}+Shift+Z`]: 'Redo',
    [`${mod}+Y`]: 'Redo',
    [`${mod}+C`]: 'Copy',
    [`${mod}+X`]: 'Cut',
    [`${mod}+V`]: 'Paste',
    [`${mod}+A`]: 'Select All',
    F11: 'Full Screen',
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${mod}+${i + 1}`, `Go to Tab ${i + 1}`])),
    ...(isMac ? { 'Cmd+H': 'Hide ZITEXT', 'Cmd+M': 'Minimize' } : {}),
};

/** The binding in effect for a command: the user's, or the default. */
export function bindingFor(id: string, custom: Record<string, string>): ReturnType<typeof parseBinding> {
    const binding = custom[id] || COMMANDS.find(command => command.id === id)?.defaultKey;
    if (!binding) throw new Error(`Unknown command: ${id}`);
    return parseBinding(binding);
}
