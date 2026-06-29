import { useEffect, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'github-markdown-css/github-markdown.css';

interface MarkdownPreviewProps {
    content: string;
    theme: 'light' | 'dark';
}

export function MarkdownPreview({ content, theme }: MarkdownPreviewProps) {
    const [html, setHtml] = useState('');

    useEffect(() => {
        const renderMarkdown = async () => {
            const rawHtml = await marked.parse(content);
            // Explicit allowlist prevents SVG/MathML event-handler injection and
            // other vectors not blocked by DOMPurify's default heuristics.
            const cleanHtml = DOMPurify.sanitize(rawHtml, {
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
                    'class', 'id', 'lang',
                    'width', 'height',
                    'align', 'valign',
                    'colspan', 'rowspan',
                    'start',                 // ordered list start number
                    'type', 'checked', 'disabled', // task-list checkboxes
                    'open',                  // <details open>
                ],
                ALLOW_DATA_ATTR: true,       // allow data-* for syntax-highlight libs
                FORBID_TAGS: ['style', 'script', 'svg', 'math'],
                FORBID_ATTR: ['style'],      // no inline styles (XSS via CSS expressions)
            });
            setHtml(cleanHtml);
        };

        renderMarkdown();
    }, [content]);

    return (
        <div className={`markdown-preview-container ${theme}`}>
            <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: html }}
                style={{
                    color: theme === 'dark' ? '#c9d1d9' : '#24292f'
                }}
            />
        </div>
    );
}
