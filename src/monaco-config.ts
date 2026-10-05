import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
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

// Vite worker imports resolve to hashed production assets and valid dev URLs.
// Returning Worker instances also covers Monaco's base editor worker, which
// was previously configured as an editor.worker.js file that never existed.
self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') {
      return new JsonWorker();
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new CssWorker();
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new HtmlWorker();
    }
    if (label === 'typescript' || label === 'javascript') {
      return new TypeScriptWorker();
    }
    return new EditorWorker();
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

/* Monaco's stock vs-dark paints the canvas #1e1e1e, which is a different shade
   from the app's own --bg. That left a visible seam between the editor and the
   chrome around it. These themes take their surface colours from the design
   tokens instead, so the two are literally the same colour; syntax colours are
   inherited from the base theme and left alone.

   Defined here so a theme name always exists before the first editor mounts.
   App.tsx redefines them from the live tokens once a theme is resolved, which
   is what makes them follow a light/dark switch. */
export const ZITEXT_THEME = 'zitext';

/* Monaco rejects a colour it cannot parse by throwing, and this runs from an
   effect — an exception here would take down the whole tree rather than just
   leaving the editor on its previous theme. Hence the sanitising and the catch. */
export function defineEditorTheme(
    isDark: boolean,
    token: (name: string, fallback: string) => string,
): string {
    /* Monaco accepts #rrggbb and #rrggbbaa only — the three- and four-digit CSS
       shorthands make it throw "Illegal value for token color".

       That matters because the values arrive from the stylesheet, not from this
       file: the production CSS minifier rewrites #ffffff to #fff, so a token
       written six digits in tokens.css reaches here as three in a build (never
       in dev, which is why this only ever showed up in a packaged app). Light
       --bg is exactly such a value, so defineTheme threw on every switch to
       light and the editor stayed on the dark theme while the chrome changed.

       So expand the shorthand rather than pass it through. Anything still
       unparseable (a computed rgb(), a stray var(), an empty token) falls back. */
    const normalise = (value: string): string | null => {
        const v = value.trim();
        if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
        if (/^#[0-9a-f]{3,4}$/i.test(v)) return '#' + v.slice(1).replace(/./g, (c) => c + c);
        return null;
    };

    const hex = (name: string, fallback: string): string =>
        normalise(token(name, fallback)) ?? normalise(fallback) ?? (isDark ? '#000000' : '#ffffff');

    const bg = hex('--bg', isDark ? '#15171b' : '#ffffff');

    try {
        monaco.editor.defineTheme(ZITEXT_THEME, {
            base: isDark ? 'vs-dark' : 'vs',
            inherit: true,
            rules: [],
            colors: {
                'editor.background': bg,
                'editorGutter.background': bg,
                'minimap.background': bg,
                'editorWidget.background': bg,
                'editorLineNumber.foreground': hex('--text-dim', isDark ? '#626a77' : '#7a8390'),
                'editorLineNumber.activeForeground': hex('--text-muted', isDark ? '#8b93a1' : '#5a6371'),
                'editor.lineHighlightBackground': hex('--bg-hover', isDark ? '#23272e' : '#edeff3'),
                'editorWidget.border': hex('--border', isDark ? '#2b3038' : '#e2e5ea'),
            },
        });
        return ZITEXT_THEME;
    } catch (error) {
        /* Returning a builtin rather than ZITEXT_THEME matters: the definition
           under that name is still the *previous* theme, so re-applying it would
           leave the editor dark inside a light window — a silent failure that
           reads as "the theme switch is broken" rather than "a colour was bad".
           The builtin gets the light/dark polarity right at least. */
        console.error('Failed to define the editor theme; falling back to the builtin.', error);
        return isDark ? 'vs-dark' : 'vs';
    }
}

// Seeded with the dark defaults; App.tsx refines this from the live tokens.
defineEditorTheme(true, (_, fallback) => fallback);

export default monaco;
