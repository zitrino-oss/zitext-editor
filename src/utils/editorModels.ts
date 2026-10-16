import monaco from '../monaco-config';
import { modelUriForTab } from './editorModelIdentity';
export { modelUriForTab } from './editorModelIdentity';

export function getModelForTab(tabId: string) {
    return monaco.editor.getModel(monaco.Uri.parse(modelUriForTab(tabId)));
}

const MAX_DISPOSE_ATTEMPTS = 20;

/**
 * Disposes a closed tab's model once no editor is showing it any more.
 * The tab is removed from state first; disposal waits until React has
 * switched every editor to another model, because disposing a model an
 * editor still holds makes that editor's next sync read a null model and
 * throw.
 */
export function disposeModelForTab(tabId: string, attempt = 0): void {
    setTimeout(() => {
        const model = getModelForTab(tabId);
        if (!model || model.isDisposed()) return;
        const attached = monaco.editor.getEditors().some(editor => editor.getModel() === model);
        if (attached && attempt < MAX_DISPOSE_ATTEMPTS) {
            disposeModelForTab(tabId, attempt + 1);
            return;
        }
        if (!attached) model.dispose();
    }, attempt === 0 ? 0 : 50);
}
