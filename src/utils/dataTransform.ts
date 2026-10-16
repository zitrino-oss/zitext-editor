/**
 * Shared rules for the JSON/XML/YAML data tools and Format on Save.
 */
import type { Tab } from '../types';

/**
 * Keeps the original document's line endings and final newline after a
 * formatter ran. Formatters emit LF and drop the trailing newline; applying
 * that as-is turned CRLF files into LF and removed the final newline, so the
 * whole file showed as changed in version control.
 */
export function preserveTextShape(original: string, formatted: string): string {
    const crlf = original.includes('\r\n');
    const finalNewline = /\r?\n$/.test(original);
    let out = formatted.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (finalNewline) out += '\n';
    return crlf ? out.replace(/\n/g, '\r\n') : out;
}

export type DataTransformResult =
    | { kind: 'changed'; content: string }
    | { kind: 'unchanged' }
    | { kind: 'readOnly' }
    | { kind: 'error'; error: Error };

/**
 * Runs a content transform (format, minify, sort keys) for a document.
 * Read-only documents are never changed: the editor blocked typing but the
 * palette tools used to rewrite the content anyway (and autosave then wrote
 * it to disk).
 */
export function applyDataTransform(
    doc: { content: string; isReadOnly: boolean },
    transform: (text: string) => string,
): DataTransformResult {
    if (doc.isReadOnly) return { kind: 'readOnly' };
    try {
        const content = preserveTextShape(doc.content, transform(doc.content));
        return content === doc.content ? { kind: 'unchanged' } : { kind: 'changed', content };
    } catch (error) {
        return { kind: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }
}

export type AsyncDataTransformResult = DataTransformResult | { kind: 'stale' };

/**
 * Like applyDataTransform, for a transform that runs in the background.
 * The result is only offered if the document still has the
 * text it was computed from: applying it over later typing would lose that
 * typing.
 */
export async function applyDataTransformAsync(
    doc: { content: string; isReadOnly: boolean },
    transform: (text: string) => Promise<string>,
    currentContent: () => string | undefined,
): Promise<AsyncDataTransformResult> {
    if (doc.isReadOnly) return { kind: 'readOnly' };
    const original = doc.content;
    let formatted: string;
    try {
        formatted = await transform(original);
    } catch (error) {
        return { kind: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (currentContent() !== original) return { kind: 'stale' };
    const content = preserveTextShape(original, formatted);
    return content === original ? { kind: 'unchanged' } : { kind: 'changed', content };
}

/**
 * Format on Save applies to documents that already have a file: never to a
 * read-only document, and not to an untitled one, whose save starts with a
 * Save As dialog that may be cancelled.
 */
export function shouldFormatOnSave(tab: Pick<Tab, 'isReadOnly' | 'path'>, formatOnSave: boolean): boolean {
    return formatOnSave && !tab.isReadOnly && tab.path !== null;
}
