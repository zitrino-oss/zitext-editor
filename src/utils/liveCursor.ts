import { useSyncExternalStore } from 'react';

/**
 * The cursor position of each tab as the editor reports it, for the status
 * bar. Tab state takes the position only once the cursor
 * settles, so moving the cursor no longer re-renders the whole app; the
 * status bar subscribes here and updates on every move.
 */
type Position = { line: number; column: number };

const positions = new Map<string, Position>();
const listeners = new Set<() => void>();

export function setLiveCursor(tabId: string, line: number, column: number): void {
    const current = positions.get(tabId);
    if (current && current.line === line && current.column === column) return;
    positions.set(tabId, { line, column });
    listeners.forEach(listener => listener());
}

export function clearLiveCursor(tabId: string): void {
    if (positions.delete(tabId)) listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The live position of `tabId`, or `fallback` when the editor hasn't reported one. */
export function useLiveCursor(tabId: string | null, fallback: Position): Position {
    const position = useSyncExternalStore(subscribe, () => (tabId ? positions.get(tabId) : undefined));
    return position ?? fallback;
}
