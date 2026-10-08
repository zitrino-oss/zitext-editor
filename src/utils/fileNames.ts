import { isWindows } from './shortcuts';
import { extensionForLanguage } from './languageDetection';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Why `name` can't be used as a file name, or null if it can. Mirrors the
 * backend check (validate_file_name) so mistakes are reported before any
 * file operation starts.
 */
export function fileNameError(name: string, windows: boolean = isWindows): string | null {
    if (name.trim() === '' || name === '.' || name === '..') return 'Enter a file name.';
    if (name.length > 255) return 'That file name is too long.';
    if (/[/\\\0]/.test(name)) return 'A file name can\'t contain / or \\.';
    if (windows) {
        if (/[<>:"|?*\x00-\x1f]/.test(name)) return 'A file name can\'t contain any of < > : " | ? *';
        if (/[. ]$/.test(name)) return 'A file name can\'t end with a dot or a space.';
        const stem = name.split('.')[0].trimEnd();
        if (WINDOWS_RESERVED.test(stem)) return `${stem.toUpperCase()} is a reserved name on Windows.`;
    }
    return null;
}

/**
 * The name proposed when an untitled document is first saved: its title,
 * with the extension of its language when it has none (so a Python buffer
 * is offered as "Untitled-1.py", not ".txt").
 */
export function suggestedFileName(title: string, language: string): string {
    if (/\.[^.\s]+$/.test(title)) return title;
    return `${title}.${extensionForLanguage(language)}`;
}
