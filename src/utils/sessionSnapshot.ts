import type { SessionFile, Tab } from '../types';

/** Mirrors the backend's MAX_SESSION_FILES. */
export const MAX_SESSION_ENTRIES = 100;
/** Mirrors the backend's per-buffer cap (MAX_SESSION_CONTENT_BYTES, raw UTF-8). */
export const MAX_RECOVERY_BUFFER_BYTES = 10 * 1024 * 1024;
/**
 * Total recovery content kept per snapshot, measured as JSON-escaped UTF-8.
 * The backend allows 32 MiB of raw content inside a 40 MiB settings file;
 * escaping (quotes, backslashes, newlines) can inflate content, so the
 * renderer budgets on the escaped size with headroom for everything else.
 */
export const RECOVERY_CONTENT_BUDGET_BYTES = 24 * 1024 * 1024;

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;
const escapedByteLength = (s: string): number => byteLength(JSON.stringify(s));

export interface SessionSnapshot {
    session: SessionFile[];
    /** Titles of unsaved documents whose content could not be kept. */
    omitted: string[];
}

/**
 * Builds the crash-recovery snapshot for the current tabs.
 *
 * Unsaved content (untitled buffers and dirty saved files) is kept within the
 * per-buffer and total budgets, preferring the active tab and then smaller
 * buffers so as many documents as possible survive. Tab order is preserved in
 * the output. Anything that cannot be kept is reported in `omitted` so the user
 * can be told, instead of the whole snapshot being rejected by the backend.
 */
export function buildSessionSnapshot(tabs: Tab[], activeTabId: string | null): SessionSnapshot {
    const hasRecoverableContent = (tab: Tab) =>
        tab.path === null ? tab.content.length > 0 : tab.isDirty;

    // Decide which buffers keep their content, in priority order.
    const candidates = tabs
        .filter(hasRecoverableContent)
        .map(tab => ({ tab, raw: byteLength(tab.content), escaped: escapedByteLength(tab.content) }))
        .sort((a, b) => {
            if (a.tab.id === activeTabId) return -1;
            if (b.tab.id === activeTabId) return 1;
            return a.escaped - b.escaped;
        });
    const keepContent = new Set<string>();
    const omittedIds = new Set<string>();
    let used = 0;
    for (const { tab, raw, escaped } of candidates) {
        if (raw <= MAX_RECOVERY_BUFFER_BYTES && used + escaped <= RECOVERY_CONTENT_BUDGET_BYTES) {
            keepContent.add(tab.id);
            used += escaped;
        } else {
            omittedIds.add(tab.id);
        }
    }

    const session: SessionFile[] = [];
    for (const tab of tabs) {
        const common = {
            cursor_line: tab.cursorLine,
            cursor_column: tab.cursorColumn,
            scroll_top: tab.scrollTop,
            scroll_left: tab.scrollLeft,
            is_active: tab.id === activeTabId,
        };
        if (tab.path !== null) {
            if (keepContent.has(tab.id)) {
                session.push({
                    path: tab.path,
                    ...common,
                    is_dirty: true,
                    content: tab.content,
                    ...(tab.diskVersion ? { base_version: tab.diskVersion } : {}),
                });
            } else {
                // Clean file, or a dirty one over budget: reopen from disk.
                session.push({ path: tab.path, ...common });
            }
        } else if (keepContent.has(tab.id)) {
            session.push({ path: tab.title, ...common, is_untitled: true, content: tab.content });
        }
        // Empty untitled tabs hold nothing to recover; untitled tabs over
        // budget can't be represented without content (reported below).
    }

    // Entry-count cap: drop clean (contentless) disk entries from the end
    // first, then the lowest-priority content entries.
    while (session.length > MAX_SESSION_ENTRIES) {
        let index = -1;
        for (let i = session.length - 1; i >= 0; i--) {
            if (session[i].content === undefined) { index = i; break; }
        }
        if (index === -1) index = session.length - 1;
        const [removed] = session.splice(index, 1);
        if (removed.content !== undefined) {
            const tab = tabs.find(t => (t.path ?? t.title) === removed.path);
            if (tab) omittedIds.add(tab.id);
        }
    }

    const omitted = tabs.filter(tab => omittedIds.has(tab.id)).map(tab => tab.title);
    return { session, omitted };
}
