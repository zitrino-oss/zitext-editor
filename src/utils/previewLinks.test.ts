import { describe, expect, it } from 'vitest';
import { classifyPreviewLink, headingSlug } from './previewLinks';

// Preview links must never navigate the app webview.
describe('classifyPreviewLink', () => {
    const doc = '/home/me/project/README.md';

    it('treats #fragments as in-preview anchors', () => {
        expect(classifyPreviewLink('#getting-started', doc)).toEqual({ kind: 'anchor', id: 'getting-started' });
        expect(classifyPreviewLink('#caf%C3%A9', doc)).toEqual({ kind: 'anchor', id: 'café' });
        expect(classifyPreviewLink('#', doc)).toEqual({ kind: 'ignore' });
    });

    it('routes http(s) and mailto to the external opener', () => {
        expect(classifyPreviewLink('https://example.com/a?b=1', doc)).toEqual({ kind: 'external', url: 'https://example.com/a?b=1' });
        expect(classifyPreviewLink('http://example.com', doc)).toEqual({ kind: 'external', url: 'http://example.com/' });
        expect(classifyPreviewLink('mailto:dev@example.com', doc)).toEqual({ kind: 'external', url: 'mailto:dev@example.com' });
    });

    it('ignores every other scheme and protocol-relative links', () => {
        for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'tauri://localhost/x', 'ftp://h/x', '//evil.example/x', 'https://']) {
            expect(classifyPreviewLink(href, doc)).toEqual({ kind: 'ignore' });
        }
    });

    it('resolves relative links against the document folder', () => {
        expect(classifyPreviewLink('docs/guide.md', doc)).toEqual({ kind: 'file', path: '/home/me/project/docs/guide.md' });
        expect(classifyPreviewLink('./a%20b.md#section', doc)).toEqual({ kind: 'file', path: '/home/me/project/a b.md' });
        expect(classifyPreviewLink('../other/x.txt', doc)).toEqual({ kind: 'file', path: '/home/me/other/x.txt' });
        expect(classifyPreviewLink('/etc/hosts', doc)).toEqual({ kind: 'file', path: '/etc/hosts' });
    });

    it('handles Windows document paths and drive-letter links', () => {
        const winDoc = 'C:\\Users\\me\\project\\README.md';
        expect(classifyPreviewLink('docs/guide.md', winDoc)).toEqual({ kind: 'file', path: 'C:\\Users\\me\\project\\docs\\guide.md' });
        expect(classifyPreviewLink('..\\notes.txt', winDoc)).toEqual({ kind: 'file', path: 'C:\\Users\\me\\notes.txt' });
        expect(classifyPreviewLink('D:\\data\\x.csv', winDoc)).toEqual({ kind: 'file', path: 'D:\\data\\x.csv' });
    });

    it('ignores relative links for untitled documents and paths above the root', () => {
        expect(classifyPreviewLink('docs/guide.md', null)).toEqual({ kind: 'ignore' });
        expect(classifyPreviewLink('../../../../x', '/a/b.md')).toEqual({ kind: 'ignore' });
        expect(classifyPreviewLink('', doc)).toEqual({ kind: 'ignore' });
        expect(classifyPreviewLink(null, doc)).toEqual({ kind: 'ignore' });
    });
});

describe('headingSlug', () => {
    it('matches GitHub-style anchors', () => {
        expect(headingSlug('Getting Started')).toBe('getting-started');
        expect(headingSlug('Hello World!')).toBe('hello-world');
        expect(headingSlug('  API v2.0 (beta) ')).toBe('api-v20-beta');
        expect(headingSlug('Café & Crème')).toBe('café--crème');
    });
});
