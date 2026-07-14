import { useRef, useEffect, useCallback, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import '../monaco-config'; // Configure Monaco workers

interface EditorPanelProps {
    modelPath: string;
    content: string;
    language: string;
    editorTheme: string;
    fontSize: number;
    fontFamily: string;
    wordWrap: boolean;
    showMinimap: boolean;
    isReadOnly: boolean;
    enableColumnSelection: boolean;
    tabSize: number;
    insertSpaces: boolean;
    cursorLine: number;
    cursorColumn: number;
    scrollTop: number;
    scrollLeft: number;
    /** Custom keybinding string for Find (e.g. "Ctrl+F"). If omitted, uses Ctrl/Cmd+F. */
    findKeybinding?: string;
    /** Custom keybinding string for Find & Replace (e.g. "Ctrl+H"). If omitted, uses Ctrl/Cmd+H. */
    replaceKeybinding?: string;
    onChange: (value: string) => void;
    onCursorChange: (line: number, column: number) => void;
    onScrollChange?: (scrollTop: number, scrollLeft: number) => void;
    onSelectionChange?: (selectionLength: number) => void;
    onEditorReady?: (editor: editor.IStandaloneCodeEditor) => void;
    onFocus?: () => void;
}

// Maps from the key string stored by KeybindingEditor (e.key / 'Space' / 'F1' etc.)
// to candidate Monaco KeyCode names. Multiple candidates handle naming differences
// across Monaco versions (e.g. 'Slash' in newer vs 'US_SLASH' in older builds).
const MONACO_KEY_MAP: Record<string, string[]> = {
    // Digits
    '0': ['Digit0'], '1': ['Digit1'], '2': ['Digit2'], '3': ['Digit3'],
    '4': ['Digit4'], '5': ['Digit5'], '6': ['Digit6'], '7': ['Digit7'],
    '8': ['Digit8'], '9': ['Digit9'],
    // Function keys
    'F1':  ['F1'],  'F2':  ['F2'],  'F3':  ['F3'],  'F4':  ['F4'],
    'F5':  ['F5'],  'F6':  ['F6'],  'F7':  ['F7'],  'F8':  ['F8'],
    'F9':  ['F9'],  'F10': ['F10'], 'F11': ['F11'], 'F12': ['F12'],
    // Whitespace / navigation
    'SPACE':     ['Space'],
    'TAB':       ['Tab'],
    'ENTER':     ['Enter'],
    'ESCAPE':    ['Escape'],
    'BACKSPACE': ['Backspace'],
    'DELETE':    ['Delete'],
    // Symbols (stored uppercase by KeybindingEditor for length-1 chars)
    '/':  ['Slash',       'US_SLASH'],
    ',':  ['Comma',       'US_COMMA'],
    '.':  ['Period',      'US_PERIOD'],
    '=':  ['Equal',       'US_EQUAL'],
    '-':  ['Minus',       'US_MINUS'],
    ';':  ['Semicolon',   'US_SEMICOLON'],
    "'":  ['Quote',       'US_QUOTE'],
    '`':  ['Backquote',   'US_BACKTICK'],
    '[':  ['BracketLeft', 'US_OPEN_SQUARE_BRACKET'],
    ']':  ['BracketRight','US_CLOSE_SQUARE_BRACKET'],
    '\\': ['Backslash',   'US_BACKSLASH'],
};

/**
 * Parse a binding string like "Ctrl+Shift+G" or "Ctrl+1" into a Monaco keybinding
 * number. Returns null if the key portion cannot be mapped (caller should fall back
 * to the default keybinding).
 */
function parseMonacoKey(binding: string, monaco: Monaco): number | null {
    const kc = monaco.KeyCode as unknown as Record<string, number>;
    const parts = binding.split('+');
    let result = 0;
    let hasKey = false;

    for (const part of parts) {
        switch (part.toLowerCase()) {
            case 'ctrl':
            case 'cmd':
                result |= monaco.KeyMod.CtrlCmd;
                break;
            case 'shift':
                result |= monaco.KeyMod.Shift;
                break;
            case 'alt':
            case 'option':
                result |= monaco.KeyMod.Alt;
                break;
            default: {
                const upper = part.toUpperCase();
                // Letters A-Z → KeyCode.KeyA … KeyCode.KeyZ
                if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
                    const code = kc[`Key${upper}`];
                    if (code !== undefined) { result |= code; hasKey = true; }
                    break;
                }
                // Everything else: look up in the table (try each candidate name)
                const candidates = MONACO_KEY_MAP[part] ?? MONACO_KEY_MAP[upper];
                if (candidates) {
                    for (const name of candidates) {
                        const code = kc[name];
                        if (code !== undefined) { result |= code; hasKey = true; break; }
                    }
                }
                break;
            }
        }
    }
    return hasKey ? result : null;
}

export function EditorPanel({
    modelPath,
    content,
    language,
    editorTheme,
    fontSize,
    fontFamily,
    wordWrap,
    showMinimap,
    isReadOnly,
    enableColumnSelection,
    tabSize,
    insertSpaces,
    cursorLine,
    cursorColumn,
    scrollTop,
    scrollLeft,
    findKeybinding,
    replaceKeybinding,
    onChange,
    onCursorChange,
    onScrollChange,
    onSelectionChange,
    onEditorReady,
    onFocus,
}: EditorPanelProps) {
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    // Tracks the Monaco keybinding values that are currently registered, so that
    // when the user changes a binding we can no-op the old key before registering
    // the new one (Monaco addCommand uses last-registered-wins for the same key).
    const activeFindKeyRef = useRef<number | null>(null);
    const activeReplaceKeyRef = useRef<number | null>(null);
    const [isEditorReady, setIsEditorReady] = useState(false);
    const onCursorChangeRef = useRef(onCursorChange);
    const onScrollChangeRef = useRef(onScrollChange);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const onEditorReadyRef = useRef(onEditorReady);
    const onFocusRef = useRef(onFocus);
    onCursorChangeRef.current = onCursorChange;
    onScrollChangeRef.current = onScrollChange;
    onSelectionChangeRef.current = onSelectionChange;
    onEditorReadyRef.current = onEditorReady;
    onFocusRef.current = onFocus;

    // True while the user is holding the mouse button inside the editor.
    // The cursor-sync useEffect checks this flag and skips setPosition() while a drag is
    // in progress.  Without this guard the state/prop round-trip lags behind Monaco's actual
    // cursor during a drag-select, and the stale prop triggers setPosition() mid-stroke —
    // collapsing the selection and making it impossible to select more than a line or two.
    const isDraggingRef = useRef(false);

    // The last cursor position the editor itself emitted via onDidChangeCursorPosition.
    // Because cursorLine/cursorColumn are fed straight back from that callback, every
    // keystroke round-trips through props into the cursor-sync effect below. Comparing
    // incoming props against this ref lets us ignore those echoes and only re-position
    // Monaco for genuinely external changes (Go To Line, session restore).
    const lastEmittedPosRef = useRef<{ line: number; column: number } | null>(null);

    // Wire up the drag-detection listeners once the editor DOM node is available.
    // When the Column Selection setting is on, holding Alt flips Monaco into
    // columnSelection mode so an Alt(+Shift)+drag makes a rectangular block
    // selection; releasing Alt restores normal selection. When the setting is
    // off, the Alt listeners are not attached and columnSelection stays false,
    // so the toggle actually controls the behavior.
    useEffect(() => {
        if (!isEditorReady || !editorRef.current) return;
        const domNode = editorRef.current.getDomNode();
        if (!domNode) return;
        const onMouseDown = () => { isDraggingRef.current = true; };
        const onMouseUp   = () => { isDraggingRef.current = false; };
        domNode.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);   // global — catches release anywhere

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Alt') editorRef.current?.updateOptions({ columnSelection: true });
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Alt') editorRef.current?.updateOptions({ columnSelection: false });
        };
        if (enableColumnSelection) {
            window.addEventListener('keydown', onKeyDown);
            window.addEventListener('keyup', onKeyUp);
        } else {
            // Ensure a stale "Alt was held" state can't leave column mode stuck on
            // after the user turns the setting off.
            editorRef.current.updateOptions({ columnSelection: false });
        }

        return () => {
            domNode.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [isEditorReady, enableColumnSelection]);

    useEffect(() => {
        if (!isEditorReady || !editorRef.current || !monacoRef.current) return;
        const editor = editorRef.current;
        const monaco = monacoRef.current;

        const defaultFindKey = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF;
        const defaultReplaceKey = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH;

        const newFindKey = findKeybinding
            ? (parseMonacoKey(findKeybinding, monaco) ?? defaultFindKey)
            : defaultFindKey;
        const newReplaceKey = replaceKeybinding
            ? (parseMonacoKey(replaceKeybinding, monaco) ?? defaultReplaceKey)
            : defaultReplaceKey;

        // If the find key changed, no-op the old one so it no longer opens Monaco's
        // built-in find widget or fires the previous custom handler.
        if (activeFindKeyRef.current !== null && activeFindKeyRef.current !== newFindKey) {
            editor.addCommand(activeFindKeyRef.current, () => { /* no-op: key was rebound */ });
        }
        editor.addCommand(newFindKey, () => {
            window.dispatchEvent(new CustomEvent('zitext-find'));
        });
        activeFindKeyRef.current = newFindKey;

        if (activeReplaceKeyRef.current !== null && activeReplaceKeyRef.current !== newReplaceKey) {
            editor.addCommand(activeReplaceKeyRef.current, () => { /* no-op: key was rebound */ });
        }
        editor.addCommand(newReplaceKey, () => {
            window.dispatchEvent(new CustomEvent('zitext-replace'));
        });
        activeReplaceKeyRef.current = newReplaceKey;

        // Suppress Monaco's built-in "Go to Line" widget (editor.action.gotoLine,
        // bound to Ctrl/Cmd+G). The app's global keydown handler already opens our
        // custom GoToLineModal on this chord; without this no-op override both the
        // native widget and the modal appear at once.
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => { /* no-op */ });
    }, [isEditorReady, findKeybinding, replaceKeybinding]);

    useEffect(() => {
        if (!editorRef.current) return;
        // Never call setPosition() while the mouse is held in the editor.
        // The state/prop round-trip lags behind Monaco's actual position during a
        // drag-select, so a stale prop would collapse the in-progress selection.
        if (isDraggingRef.current) return;
        // Skip echoes of the editor's own cursor movements. Typing fires
        // onDidChangeCursorPosition, which flows back here as new props one render
        // later; re-applying that value with setPosition() is what yanked the caret
        // away from where the user was typing. The props only differ from the last
        // emitted position for genuinely external changes (Go To Line, restore).
        const last = lastEmittedPosRef.current;
        if (last && last.line === cursorLine && last.column === cursorColumn) return;
        const pos = editorRef.current.getPosition();
        if (pos && pos.lineNumber === cursorLine && pos.column === cursorColumn) return;
        editorRef.current.setPosition({ lineNumber: cursorLine, column: cursorColumn });
        editorRef.current.revealLineInCenterIfOutsideViewport(cursorLine);
    }, [cursorLine, cursorColumn]);

    useEffect(() => {
        if (!editorRef.current) return;
        editorRef.current.setScrollPosition({ scrollTop, scrollLeft });
    }, [modelPath, scrollTop, scrollLeft]);

    const handleEditorWillMount = (monaco: Monaco) => {
        monacoRef.current = monaco;
        monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
            validate: true,
            allowComments: false,
            schemas: [],
            enableSchemaRequest: true,
        });
        monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
        monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    };

    const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor, monaco: Monaco) => {
        editorRef.current = editor;
        // Keybinding overrides (Find / Replace) are registered in the useEffect above,
        // which fires once isEditorReady becomes true.
        setIsEditorReady(true);

        editor.setPosition({ lineNumber: cursorLine, column: cursorColumn });
        editor.setScrollPosition({ scrollTop, scrollLeft });

        editor.onDidChangeCursorPosition((e) => {
            // Remember what we emit so the cursor-sync effect can tell this echo
            // apart from an external position change (see lastEmittedPosRef).
            lastEmittedPosRef.current = { line: e.position.lineNumber, column: e.position.column };
            onCursorChangeRef.current(e.position.lineNumber, e.position.column);
        });

        editor.onDidScrollChange((event) => {
            if (event.scrollTopChanged || event.scrollLeftChanged) {
                onScrollChangeRef.current?.(event.scrollTop, event.scrollLeft);
            }
        });

        // Track selection length
        if (onSelectionChangeRef.current) {
            editor.onDidChangeCursorSelection(() => {
                const selection = editor.getSelection();
                if (selection && !selection.isEmpty()) {
                    const model = editor.getModel();
                    if (model) {
                        const text = model.getValueInRange(selection);
                        onSelectionChangeRef.current?.(text.length);
                    }
                } else {
                    onSelectionChangeRef.current?.(0);
                }
            });
        }

        // Track focus
        editor.onDidFocusEditorText(() => onFocusRef.current?.());

        onEditorReadyRef.current?.(editor);

        // Route clipboard actions through the Tauri clipboard plugin. Monaco's built-in
        // context-menu Copy/Cut/Paste rely on document.execCommand, which the Windows
        // WebView2 blocks (notably paste) — so right-click Copy/Paste silently did nothing
        // (QA ZITEXT_V2_004). These overrides make them work consistently cross-platform.
        const selectedText = () => {
            const sel = editor.getSelection();
            const model = editor.getModel();
            if (!sel || !model || sel.isEmpty()) return '';
            return model.getValueInRange(sel);
        };
        editor.addAction({
            id: 'zitext.clipboardCopy',
            label: 'Copy',
            contextMenuGroupId: '9_cutcopypaste',
            contextMenuOrder: 1,
            precondition: 'editorTextFocus',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
            run: async () => { const t = selectedText(); if (t) await writeText(t); },
        });
        editor.addAction({
            id: 'zitext.clipboardCut',
            label: 'Cut',
            contextMenuGroupId: '9_cutcopypaste',
            contextMenuOrder: 2,
            precondition: 'editorTextFocus && !editorReadonly',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX],
            run: async (ed) => {
                const t = selectedText();
                if (!t) return;
                await writeText(t);
                const sel = ed.getSelection();
                if (sel) ed.executeEdits('clipboard', [{ range: sel, text: '', forceMoveMarkers: true }]);
            },
        });
        editor.addAction({
            id: 'zitext.clipboardPaste',
            label: 'Paste',
            contextMenuGroupId: '9_cutcopypaste',
            contextMenuOrder: 3,
            precondition: 'editorTextFocus && !editorReadonly',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
            run: async (ed) => {
                const text = await readText();
                if (text == null) return;
                const sel = ed.getSelection();
                if (sel) ed.executeEdits('clipboard', [{ range: sel, text, forceMoveMarkers: true }]);
                ed.focus();
            },
        });

        // The built-in Copy/Cut/Paste that these actions replace are removed from the
        // editor context menu in monaco-config.ts, so only these WebView2-safe ones show.

        editor.focus();
    }, [cursorLine, cursorColumn, scrollTop, scrollLeft]);

    function handleEditorChange(value: string | undefined) {
        if (value !== undefined) {
            onChange(value);
        }
    }

    return (
        <div className="editor-panel">
            <Editor
                height="100%"
                path={modelPath}
                language={language}
                value={content}
                theme={editorTheme}
                beforeMount={handleEditorWillMount}
                onChange={handleEditorChange}
                onMount={handleEditorDidMount}
                options={{
                    fontSize,
                    fontFamily,
                    wordWrap: wordWrap ? 'on' : 'off',
                    readOnly: isReadOnly,
                    lineNumbers: 'on',
                    minimap: { enabled: showMinimap },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    renderLineHighlight: 'all',
                    // Don't box the word under the cursor or auto-highlight text
                    // matching the current selection — users found the word-box
                    // distracting while typing.
                    occurrencesHighlight: 'off',
                    selectionHighlight: false,
                    cursorBlinking: 'smooth',
                    smoothScrolling: true,
                    contextmenu: true,
                    selectOnLineNumbers: true,
                    roundedSelection: false,
                    fixedOverflowWidgets: true,
                    padding: { top: 10, bottom: 10 },
                    columnSelection: false,
                    tabSize,
                    insertSpaces,
                    detectIndentation: false,
                    bracketPairColorization: { enabled: true },
                    folding: true,
                    foldingStrategy: 'auto',
                    foldingHighlight: true,
                    foldingImportsByDefault: false,
                    showFoldingControls: 'always',
                    unfoldOnClickAfterEndOfLine: true,
                }}
            />
        </div>
    );
}
