/**
 * Link handling for the Markdown preview.
 *
 * The preview renders untrusted document content inside the app's own
 * webview, so a link must never navigate that webview: a relative link would
 * reload the whole app (losing unsaved work) and an external one would load a
 * remote page in the trusted window. Every click is intercepted and routed
 * through classifyPreviewLink instead.
 */

export type PreviewLinkAction =
    | { kind: 'anchor'; id: string }
    | { kind: 'external'; url: string }
    | { kind: 'file'; path: string }
    | { kind: 'ignore' };

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** Resolves `target` against the directory of `documentPath`, normalizing `.`/`..`. */
function resolveAgainstDocument(target: string, documentPath: string): string | null {
    const separator = documentPath.includes('\\') && !documentPath.includes('/') ? '\\' : '/';
    const isAbsolute = target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target);
    const docParts = documentPath.split(/[\\/]/);
    docParts.pop(); // file name
    const parts = isAbsolute ? [] : docParts;
    for (const segment of target.split(/[\\/]/)) {
        if (segment === '' || segment === '.') {
            if (parts.length === 0) parts.push(''); // keep a leading root marker
            continue;
        }
        if (segment === '..') {
            if (parts.length > 1) parts.pop();
            else return null; // escapes above the filesystem root
            continue;
        }
        parts.push(segment);
    }
    const joined = parts.join(separator);
    if (target.startsWith('/') && !joined.startsWith(separator)) return separator + joined;
    return joined || null;
}

export function classifyPreviewLink(href: string | null, documentPath: string | null): PreviewLinkAction {
    const raw = href?.trim();
    if (!raw) return { kind: 'ignore' };

    if (raw.startsWith('#')) {
        const id = safeDecode(raw.slice(1));
        return id ? { kind: 'anchor', id } : { kind: 'ignore' };
    }

    // Windows drive paths ("C:\\x", "C:/x") look like a one-letter URL scheme.
    const isDrivePath = /^[a-zA-Z]:[\\/]/.test(raw);
    if (!isDrivePath && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
        try {
            const url = new URL(raw);
            if (!EXTERNAL_SCHEMES.has(url.protocol)) return { kind: 'ignore' };
            if (url.protocol !== 'mailto:' && !url.hostname) return { kind: 'ignore' };
            return { kind: 'external', url: url.href };
        } catch {
            return { kind: 'ignore' };
        }
    }
    if (raw.startsWith('//')) return { kind: 'ignore' }; // protocol-relative: ambiguous

    if (!documentPath) return { kind: 'ignore' };
    const target = safeDecode(raw.split(/[?#]/)[0]);
    if (!target) return { kind: 'ignore' };
    const path = resolveAgainstDocument(target, documentPath);
    return path ? { kind: 'file', path } : { kind: 'ignore' };
}

/** GitHub-style heading slug, used to resolve `#anchor` links in the preview. */
export function headingSlug(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
}
