import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// Deep import: MenuRegistry/MenuId are not part of Monaco's public API surface.
// Resolves to the same singleton editor.main already populated above.
// @ts-expect-error - no type declarations for this internal module path
import { MenuRegistry, MenuId } from 'monaco-editor/esm/vs/platform/actions/common/actions';

// Configure Monaco to use self-hosted workers
loader.config({ monaco });

// Remove Monaco's built-in Copy/Cut/Paste from the editor context menu. They rely on
// document.execCommand, which Windows WebView2 blocks (paste silently did nothing), so
// EditorPanel adds WebView2-safe replacements via the Tauri clipboard plugin. Both sets
// shared the same context-menu group, so every entry appeared twice (duplicate Paste,
// QA ZITEXT_V2_004). Dropping the built-ins here leaves only the working replacements.
(() => {
    const BUILT_IN_CLIPBOARD_ACTION_IDS = new Set([
        'editor.action.clipboardCopyAction',
        'editor.action.clipboardCutAction',
        'editor.action.clipboardPasteAction',
    ]);
    const registry = MenuRegistry as unknown as {
        _menuItems?: Map<unknown, {
            clear(): void;
            push(item: unknown): void;
            [Symbol.iterator](): Iterator<{ command?: { id?: string } }>;
        }>;
    };
    const items = registry._menuItems?.get(MenuId.EditorContext);
    if (!items) return;
    const kept = [...items].filter((item) => {
        const id = item?.command?.id;
        return !id || !BUILT_IN_CLIPBOARD_ACTION_IDS.has(id);
    });
    items.clear();
    for (const item of kept) items.push(item);
})();

// Set up worker paths for production builds
self.MonacoEnvironment = {
  getWorkerUrl: function (_moduleId: string, label: string) {
    if (label === 'json') {
      return './json.worker.js';
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return './css.worker.js';
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return './html.worker.js';
    }
    if (label === 'typescript' || label === 'javascript') {
      return './ts.worker.js';
    }
    return './editor.worker.js';
  },
};

// Monaco caches character widths from a measurement made when an editor is created
// or its font option changes. The editor fonts are self-hosted woff2s loaded with
// font-display: swap (public/fonts.css), so on machines where the chosen font isn't
// installed the swap lands *after* Monaco has measured the interim fallback — every
// caret position is then computed with the wrong width and drifts further off per
// column (right if the real font is narrower than the fallback, left if wider).
// Re-measure whenever fonts finish loading. The 'loadingdone' listener is required
// in addition to fonts.ready: unicode-range makes fonts load lazily, so a font can
// arrive long after fonts.ready resolves (e.g. on the first character typed).
if (typeof document !== 'undefined' && 'fonts' in document) {
  document.fonts.ready.then(() => monaco.editor.remeasureFonts());
  document.fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());
}

export default monaco;
