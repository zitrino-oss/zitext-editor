/**
 * The clipboard items every ZITEXT editor has. monaco-config removes Monaco's
 * own Cut/Copy/Paste (WebView2 blocks them); EditorPanel adds these, and the
 * editors of views (File Compare, Scratchpad) add them through here.
 */
import type { editor } from 'monaco-editor';
import monaco from '../monaco-config';
import { copySelection, cutSelection, pasteFromClipboard } from './editorCommands';

export function addClipboardActions(target: editor.IStandaloneCodeEditor): void {
    target.addAction({ id: 'zitext.clipboardCopy', label: 'Copy', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 1, precondition: 'editorTextFocus', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC], run: ed => copySelection(ed) });
    target.addAction({ id: 'zitext.clipboardCut', label: 'Cut', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 2, precondition: 'editorTextFocus && !editorReadonly', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX], run: ed => cutSelection(ed) });
    target.addAction({ id: 'zitext.clipboardPaste', label: 'Paste', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 3, precondition: 'editorTextFocus && !editorReadonly', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV], run: ed => pasteFromClipboard(ed) });
}
