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

export default monaco;
