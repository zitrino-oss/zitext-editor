/**
 * Caption for the titlebar and the OS window title: "file — project".
 *
 * Names the focused tab the way the tab bar does, so a new buffer reads
 * "Untitled-3" in both places, and follows whichever split pane has focus.
 */
export function windowCaption(
    tab: { path: string | null; title: string } | null,
    openedFolder: string | null,
): string {
    const folder = openedFolder?.split(/[/\\]/).filter(Boolean).pop() ?? null;
    if (!tab) return folder ?? 'ZITEXT Editor';
    const fileName = (tab.path ? tab.path.split(/[/\\]/).pop() : null) || tab.title || 'Untitled';
    return folder ? `${fileName} — ${folder}` : fileName;
}
