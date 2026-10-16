import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'github-markdown-css/github-markdown.css';
import { classifyPreviewLink, headingSlug } from '../utils/previewLinks';
import { errorService } from '../services/ErrorService';

// Only Markdown's own code-block language hint survives as a class. Arbitrary
// classes (and ids) let a document reuse the app's own selectors, e.g. render
// a full-window ".modal-overlay" that spoofs an app dialog and disables every
// keyboard shortcut.
const SAFE_CLASS = /^language-[\w+#.-]{1,40}$/;
let sanitizingPreview = false;
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (!sanitizingPreview || data.attrName !== 'class') return;
    const kept = data.attrValue.split(/\s+/).filter(token => SAFE_CLASS.test(token));
    if (kept.length === 0) data.keepAttr = false;
    else data.attrValue = kept.join(' ');
});

interface MarkdownPreviewProps {
    content: string;
    /** Exposes the rendered body so Find can search the preview in place. */
    bodyRef?: React.Ref<HTMLDivElement>;
    /** Path of the previewed document, for resolving relative links. */
    documentPath?: string | null;
    /** Opens a relative link's target as a tab (subject to file authorization). */
    onOpenFile?: (path: string) => void;
}

/** Above this size the preview waits longer before re-rendering. */
const LARGE_PREVIEW_CHARS = 200_000;

export function MarkdownPreview({ content, bodyRef, documentPath = null, onOpenFile }: MarkdownPreviewProps) {
    const [html, setHtml] = useState('');
    const renderedOnce = useRef(false);

    // Links must never navigate the app's own webview: a relative link would
    // reload the whole app (losing unsaved work) and an external one would load
    // a remote page inside the trusted window. Every activation is intercepted.
    const handleLinkActivation = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (!anchor || !event.currentTarget.contains(anchor)) return;
        event.preventDefault();
        if (event.type !== 'click') return; // middle-click etc.: just block it

        const action = classifyPreviewLink(anchor.getAttribute('href'), documentPath);
        switch (action.kind) {
            case 'anchor': {
                const headings = event.currentTarget.querySelectorAll('h1, h2, h3, h4, h5, h6');
                const target = Array.from(headings).find(
                    heading => headingSlug(heading.textContent ?? '') === action.id.toLowerCase(),
                );
                target?.scrollIntoView({ block: 'start' });
                break;
            }
            case 'external':
                // The backend asks for native confirmation showing the full URL.
                invoke('open_external_link', { url: action.url }).catch(error =>
                    errorService.showError('Could not open link', error as Error));
                break;
            case 'file':
                onOpenFile?.(action.path);
                break;
            case 'ignore':
                break;
        }
    }, [documentPath, onOpenFile]);

    useEffect(() => {
        // A render still running for older text must not replace a newer one.
        let cancelled = false;
        const renderMarkdown = async () => {
            const rawHtml = await marked.parse(content);
            // Explicit allowlist prevents SVG/MathML event-handler injection and
            // other vectors not blocked by DOMPurify's default heuristics.
            sanitizingPreview = true;
            let cleanHtml: string;
            try {
                cleanHtml = DOMPurify.sanitize(rawHtml, {
                    ALLOWED_TAGS: [
                        // Structure
                        'div', 'span', 'p', 'br', 'hr',
                        // Headings
                        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                        // Inline formatting
                        'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
                        'mark', 'small', 'sup', 'sub', 'abbr',
                        // Code
                        'code', 'pre', 'kbd', 'samp',
                        // Blocks
                        'blockquote',
                        // Lists
                        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
                        // Tables
                        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
                        // Links & media
                        'a', 'img',
                        // Semantic / GFM
                        'details', 'summary',
                        'figure', 'figcaption',
                        // Task-list checkboxes
                        'input',
                    ],
                    ALLOWED_ATTR: [
                        'href', 'src', 'alt', 'title',
                        'class', 'lang',             // class: filtered to language-* above; no id
                        'width', 'height',
                        'align', 'valign',
                        'colspan', 'rowspan',
                        'start',                 // ordered list start number
                        'type', 'checked', 'disabled', // task-list checkboxes
                        'open',                  // <details open>
                    ],
                    ALLOW_DATA_ATTR: false,      // data-* could match app selectors
                    FORBID_TAGS: ['style', 'script', 'svg', 'math'],
                    FORBID_ATTR: ['style', 'id', 'name'], // no inline styles; no ids/names (DOM clobbering, app selectors)
                });
            } finally {
                sanitizingPreview = false;
            }
            if (!cancelled) setHtml(cleanHtml);
        };

        // Parsing and sanitizing run on this thread. While typing with the
        // preview open (split view), re-render once typing pauses instead of
        // on every keystroke; the first render is immediate.
        if (!renderedOnce.current) {
            renderedOnce.current = true;
            void renderMarkdown();
            return () => { cancelled = true; };
        }
        const delay = content.length > LARGE_PREVIEW_CHARS ? 500 : 150;
        const timer = window.setTimeout(() => { void renderMarkdown(); }, delay);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [content]);

    return (
        <div className="markdown-preview-container">
            <div
                ref={bodyRef}
                className="markdown-body"
                onClick={handleLinkActivation}
                onAuxClick={handleLinkActivation}
                dangerouslySetInnerHTML={{ __html: html }}
                /* github-markdown-css paints .markdown-body from its own
                   prefers-color-scheme rules, which ignore the app's theme
                   setting. Inline tokens outrank it, so the preview follows
                   the app instead of the OS. */
                style={{ color: 'var(--text)', backgroundColor: 'var(--bg)' }}
            />
        </div>
    );
}
