/**
 * The Markdown preview, loaded the first time a document is previewed: its
 * Markdown parser and sanitizer are the largest part of the app that most
 * sessions never use, so they stay out of the startup bundle.
 */
import { lazy, Suspense, type ComponentProps } from 'react';
import type { MarkdownPreview as Preview } from './MarkdownPreview';

const MarkdownPreview = lazy(() => import('./MarkdownPreview').then(module => ({ default: module.MarkdownPreview })));

export function LazyMarkdownPreview(props: ComponentProps<typeof Preview>) {
    return (
        <Suspense fallback={<div className="markdown-preview-loading" aria-busy="true" />}>
            <MarkdownPreview {...props} />
        </Suspense>
    );
}
