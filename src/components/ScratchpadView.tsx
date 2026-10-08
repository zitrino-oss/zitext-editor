/**
 * The Scratchpad: a note that is always there. No file name, no Save dialog;
 * the text is saved in the app's data folder as you type and comes back on
 * the next launch (utils/scratchpad). Its language is only for highlighting
 * and is remembered on this computer.
 */
import { useEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import monaco from '../monaco-config';
import { flushScratchpad, loadScratchpad, onScratchpadSaveState, scheduleScratchpadSave, scratchpadSaveProblem } from '../utils/scratchpad';
import { addClipboardActions } from '../utils/clipboardActions';
import { LANGUAGES } from '../utils/languages';
import type { ViewCommands } from '../utils/workspaceViews';

interface ScratchpadViewProps {
    visible: boolean;
    editorTheme: string;
    fontFamily: string;
    fontSize: number;
    wordWrap: boolean;
    onRegisterCommands: (commands: ViewCommands | null) => void;
}

export const SCRATCHPAD_URI = 'inmemory://scratchpad/note';
const LANGUAGE_KEY = 'zitext_scratchpad_language';

function storedLanguage(): string {
    try {
        const value = localStorage.getItem(LANGUAGE_KEY);
        if (value && LANGUAGES.some(language => language.id === value)) return value;
    } catch { /* storage unavailable */ }
    return 'plaintext';
}

export function ScratchpadView({ visible, editorTheme, fontFamily, fontSize, wordWrap, onRegisterCommands }: ScratchpadViewProps) {
    const host = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const [language, setLanguage] = useState(storedLanguage);
    const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveProblem, setSaveProblem] = useState(scratchpadSaveProblem);
    useEffect(() => onScratchpadSaveState(() => setSaveProblem(scratchpadSaveProblem())), []);
    const latest = useRef({ fontFamily, fontSize, wordWrap, language });
    latest.current = { fontFamily, fontSize, wordWrap, language };

    useEffect(() => {
        let cancelled = false;
        let created: { editor: editor.IStandaloneCodeEditor; model: editor.ITextModel; listener: { dispose(): void } } | null = null;
        const uri = monaco.Uri.parse(SCRATCHPAD_URI);
        // The note's model outlives the view: closing the Scratchpad while a
        // save is failing must not drop the text, so reopening it uses the
        // model still in memory and only a new launch reads the file.
        const existing = monaco.editor.getModel(uri);
        (existing ? Promise.resolve(null) : loadScratchpad())
            .then(text => {
                if (cancelled || !host.current) return;
                const model = existing && !existing.isDisposed()
                    ? existing
                    : monaco.editor.createModel(text ?? '', latest.current.language, uri);
                const instance = monaco.editor.create(host.current, {
                    model,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontFamily: latest.current.fontFamily,
                    fontSize: latest.current.fontSize,
                    wordWrap: latest.current.wordWrap ? 'on' : 'off',
                    scrollBeyondLastLine: false,
                });
                addClipboardActions(instance);
                const listener = model.onDidChangeContent(() => scheduleScratchpadSave(model.getValue()));
                created = { editor: instance, model, listener };
                editorRef.current = instance;
                setState('ready');
                instance.focus();
            })
            .catch(error => {
                if (cancelled) return;
                setLoadError(error instanceof Error ? error.message : String(error));
                setState('error');
            });
        return () => {
            cancelled = true;
            editorRef.current = null;
            if (created) {
                // Save what was typed last before the editor goes.
                scheduleScratchpadSave(created.model.getValue());
                void flushScratchpad();
                created.listener.dispose();
                created.editor.dispose();
            }
        };
    }, []);

    useEffect(() => { monaco.editor.setTheme(editorTheme); }, [editorTheme]);

    useEffect(() => {
        editorRef.current?.updateOptions({ fontFamily, fontSize, wordWrap: wordWrap ? 'on' : 'off' });
    }, [fontFamily, fontSize, wordWrap, state]);

    useEffect(() => {
        const model = editorRef.current?.getModel();
        if (model) monaco.editor.setModelLanguage(model, language);
        try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* storage unavailable */ }
    }, [language, state]);

    // Saved when the window is hidden too (switching apps, minimizing).
    useEffect(() => {
        const flush = () => { if (document.hidden) void flushScratchpad(); };
        document.addEventListener('visibilitychange', flush);
        return () => document.removeEventListener('visibilitychange', flush);
    }, []);

    useEffect(() => {
        if (!visible) return;
        editorRef.current?.layout();
        onRegisterCommands({
            find: () => { void editorRef.current?.getAction('actions.find')?.run(); },
            goToLine: () => { void editorRef.current?.getAction('editor.action.gotoLine')?.run(); },
            // Saved continuously; Save just makes sure nothing is waiting.
            save: () => { void flushScratchpad(); },
            activeEditor: () => editorRef.current,
        });
        return () => onRegisterCommands(null);
    }, [visible, onRegisterCommands, state]);

    return (
        <div className="scratchpad-view">
            <div className="compare-pane-header">
                <span className="compare-pane-title">Scratchpad</span>
                <span className="scratchpad-hint">Saved automatically, kept between launches</span>
                <select className="log-select scratchpad-language" aria-label="Scratchpad language" value={language} onChange={e => setLanguage(e.target.value)}>
                    {LANGUAGES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
            </div>
            {state === 'error' && (
                <div className="log-notice" role="alert"><span>The scratchpad couldn't be opened: {loadError}</span></div>
            )}
            {saveProblem && (
                <div className="log-notice scratchpad-unsaved" role="alert">
                    <span>Not saved: {saveProblem} Changes are kept here and saved as soon as that works.</span>
                </div>
            )}
            <div ref={host} className="compare-editor" />
        </div>
    );
}
