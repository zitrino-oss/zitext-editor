/**
 * Views with their own Monaco editor (Scratchpad, Compare) leave Find, Replace
 * and Go to Line to the app: its Find bar and Go to Line dialog, which App's
 * shortcut handler opens. Without this, Monaco's built-in widgets open as
 * well, on the same keys: its "Go to line" box, and its find widget, which
 * styles.css hides but whose match highlights stay. EditorPanel does the same
 * for documents.
 */
import type { editor } from 'monaco-editor';
import monaco from '../monaco-config';

export function leaveFindAndGoToLineToApp(target: editor.IStandaloneCodeEditor): void {
    const { KeyMod, KeyCode } = monaco;
    const keys = [
        KeyMod.CtrlCmd | KeyCode.KeyF,               // Find
        KeyMod.CtrlCmd | KeyCode.KeyH,               // Replace (Windows/Linux)
        KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyF,  // Replace (macOS)
        KeyMod.CtrlCmd | KeyCode.KeyG,               // Go to Line
        KeyMod.WinCtrl | KeyCode.KeyG,               // Go to Line (macOS: Ctrl+G)
    ];
    for (const key of keys) target.addCommand(key, () => { /* handled by the app */ });
}
