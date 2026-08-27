// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import {
    PREVIEW_CURRENT_CLASS,
    PREVIEW_MATCH_CLASS,
    clearPreviewHighlights,
    highlightPreviewMatches,
    setCurrentPreviewMatch,
} from './previewSearch';

const DEFAULTS = { matchCase: false, wholeWord: false, useRegex: false };

function render(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
}

describe('markdown preview search', () => {
    beforeEach(() => {
        // scrollIntoView is not implemented in jsdom.
        Element.prototype.scrollIntoView = () => {};
    });

    it('highlights every match in document order', () => {
        const root = render('<p>Planning is planning, not PLANNING twice.</p>');
        const marks = highlightPreviewMatches(root, 'planning', DEFAULTS);

        expect(marks).toHaveLength(3);
        expect(marks.map(m => m.textContent)).toEqual(['Planning', 'planning', 'PLANNING']);
        expect(root.querySelectorAll(`mark.${PREVIEW_MATCH_CLASS}`)).toHaveLength(3);
    });

    it('leaves the visible text unchanged after highlighting', () => {
        const original = 'Scope: Planning only. This document does not require code changes.';
        const root = render(`<p>${original}</p>`);
        highlightPreviewMatches(root, 'Planning', DEFAULTS);
        expect(root.textContent).toBe(original);
    });

    it('honours match case', () => {
        const root = render('<p>Planning and planning</p>');
        const marks = highlightPreviewMatches(root, 'Planning', { ...DEFAULTS, matchCase: true });
        expect(marks).toHaveLength(1);
        expect(marks[0].textContent).toBe('Planning');
    });

    it('honours whole word', () => {
        const root = render('<p>plan planning plans</p>');
        const marks = highlightPreviewMatches(root, 'plan', { ...DEFAULTS, wholeWord: true });
        expect(marks).toHaveLength(1);
    });

    it('treats the query literally unless regex is enabled', () => {
        const root = render('<p>a.c and abc</p>');
        expect(highlightPreviewMatches(root, 'a.c', DEFAULTS)).toHaveLength(1);

        clearPreviewHighlights(root);
        expect(highlightPreviewMatches(root, 'a.c', { ...DEFAULTS, useRegex: true })).toHaveLength(2);
    });

    it('returns no matches for an invalid regex instead of throwing', () => {
        const root = render('<p>anything</p>');
        expect(highlightPreviewMatches(root, '([unclosed', { ...DEFAULTS, useRegex: true })).toEqual([]);
    });

    // The bug this module exists for: markdown wraps text in <strong>/<code>,
    // so a match can straddle element boundaries that surroundContents rejects.
    it('finds a match that spans element boundaries', () => {
        const root = render('<p>guard<strong>rails</strong> mode</p>');
        const marks = highlightPreviewMatches(root, 'guardrails', DEFAULTS);
        expect(marks).toHaveLength(1);
        expect(root.textContent).toBe('guardrails mode');
    });

    it('finds matches across sibling block elements independently', () => {
        const root = render('<h1>Roadmap</h1><p>The roadmap continues</p>');
        expect(highlightPreviewMatches(root, 'roadmap', DEFAULTS)).toHaveLength(2);
    });

    it('restores the original DOM when highlights are cleared', () => {
        const html = '<p>Planning is <strong>planning</strong></p>';
        const root = render(html);
        highlightPreviewMatches(root, 'planning', DEFAULTS);
        clearPreviewHighlights(root);

        expect(root.querySelectorAll('mark')).toHaveLength(0);
        expect(root.innerHTML).toBe(html);
    });

    it('re-searching does not compound earlier splits', () => {
        const root = render('<p>planning planning</p>');
        highlightPreviewMatches(root, 'plan', DEFAULTS);
        // Without normalize() on clear, the text node is left split as
        // "plan"+"ning" and this second, longer query would find nothing.
        const marks = highlightPreviewMatches(root, 'planning', DEFAULTS);
        expect(marks).toHaveLength(2);
    });

    it('marks exactly one current match at a time', () => {
        const root = render('<p>one two one two one</p>');
        const marks = highlightPreviewMatches(root, 'one', DEFAULTS);

        setCurrentPreviewMatch(marks, 1);
        expect(root.querySelectorAll(`.${PREVIEW_CURRENT_CLASS}`)).toHaveLength(1);
        expect(marks[1].classList.contains(PREVIEW_CURRENT_CLASS)).toBe(true);

        setCurrentPreviewMatch(marks, 2);
        expect(root.querySelectorAll(`.${PREVIEW_CURRENT_CLASS}`)).toHaveLength(1);
        expect(marks[2].classList.contains(PREVIEW_CURRENT_CLASS)).toBe(true);
    });

    it('returns nothing for an empty query', () => {
        const root = render('<p>content</p>');
        expect(highlightPreviewMatches(root, '', DEFAULTS)).toEqual([]);
    });
});
