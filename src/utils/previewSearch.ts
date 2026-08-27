/**
 * Text search over the rendered Markdown preview.
 *
 * Preview mode unmounts Monaco entirely, so Find cannot go through the editor
 * model while a tab is previewing. These helpers walk the rendered output's
 * text nodes instead and wrap matches in <mark> elements, which keeps the user
 * in the preview rather than kicking them back to source view.
 */

export const PREVIEW_MATCH_CLASS = 'fr-preview-match';
export const PREVIEW_CURRENT_CLASS = 'fr-preview-current';

export interface PreviewSearchOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

interface TextChunk {
    node: Text;
    start: number;
}

export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPreviewRegex(
    query: string,
    { matchCase, wholeWord, useRegex }: PreviewSearchOptions,
): RegExp | null {
    if (!query) return null;
    let pattern = useRegex ? query : escapeRegExp(query);
    // Wrap in a non-capturing group so \b applies to the whole alternation
    // rather than binding to only the first branch of a user regex.
    if (wholeWord) pattern = `\\b(?:${pattern})\\b`;
    try {
        return new RegExp(pattern, matchCase ? 'g' : 'gi');
    } catch {
        return null; // invalid user-supplied regex — caller shows "no results"
    }
}

/** Unwrap every highlight mark and re-join the text nodes wrapping split apart. */
export function clearPreviewHighlights(root: HTMLElement): void {
    const marks = root.querySelectorAll(`mark.${PREVIEW_MATCH_CLASS}`);
    marks.forEach(mark => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
    });
    // Re-merge adjacent text nodes so the next search sees whole words instead
    // of fragments left behind by the previous one's splits.
    if (marks.length > 0) root.normalize();
}

function collectChunks(root: HTMLElement): { chunks: TextChunk[]; text: string } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const chunks: TextChunk[] = [];
    let text = '';
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
        const textNode = node as Text;
        const value = textNode.nodeValue;
        if (!value) continue;
        chunks.push({ node: textNode, start: text.length });
        text += value;
    }
    return { chunks, text };
}

/**
 * Map a flat-text offset back to a (node, offset) pair. `atEnd` picks the node
 * that *ends* at a boundary rather than the one that starts there, so a match
 * ending exactly on a node edge stays inside that node.
 */
function locate(chunks: TextChunk[], offset: number, atEnd: boolean) {
    for (const chunk of chunks) {
        const length = chunk.node.nodeValue?.length ?? 0;
        const end = chunk.start + length;
        const hit = atEnd
            ? offset > chunk.start && offset <= end
            : offset >= chunk.start && offset < end;
        if (hit) return { node: chunk.node, offset: offset - chunk.start };
    }
    return null;
}

function wrapSpan(chunks: TextChunk[], start: number, end: number): HTMLElement | null {
    const from = locate(chunks, start, false);
    const to = locate(chunks, end, true);
    if (!from || !to) return null;

    const range = document.createRange();
    try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        const mark = document.createElement('mark');
        mark.className = PREVIEW_MATCH_CLASS;
        // extractContents (rather than surroundContents) so a match spanning an
        // element boundary — `**bold**`, inline `code` — still highlights instead
        // of throwing InvalidStateError.
        mark.appendChild(range.extractContents());
        range.insertNode(mark);
        return mark;
    } catch {
        return null;
    }
}

/**
 * Highlight every match in `root`, returning the marks in document order.
 * Any previous highlights are cleared first.
 */
export function highlightPreviewMatches(
    root: HTMLElement,
    query: string,
    options: PreviewSearchOptions,
): HTMLElement[] {
    clearPreviewHighlights(root);

    const regex = buildPreviewRegex(query, options);
    if (!regex) return [];

    // Flatten to one string so a match is found regardless of the element
    // boundaries markdown rendering introduced.
    const { chunks, text } = collectChunks(root);
    if (chunks.length === 0) return [];

    const spans: { start: number; end: number }[] = [];
    for (const match of text.matchAll(regex)) {
        if (!match[0] || match.index === undefined) continue; // skip zero-width
        spans.push({ start: match.index, end: match.index + match[0].length });
    }
    if (spans.length === 0) return [];

    // Wrap back-to-front: wrapping splits text nodes, which would invalidate the
    // recorded offsets of every match later in the document.
    const marks: HTMLElement[] = [];
    for (let i = spans.length - 1; i >= 0; i--) {
        const mark = wrapSpan(chunks, spans[i].start, spans[i].end);
        if (mark) marks.push(mark);
    }
    marks.reverse();
    return marks;
}

/** Move the "current match" styling to `index` and scroll it into view. */
export function setCurrentPreviewMatch(marks: HTMLElement[], index: number): void {
    marks.forEach((mark, i) => mark.classList.toggle(PREVIEW_CURRENT_CLASS, i === index));
    // Instant, not smooth — a smooth scroll here loses the same race the editor
    // reveal did, and leaves the user staring at the wrong part of the document.
    marks[index]?.scrollIntoView({ block: 'center', inline: 'nearest' });
}
