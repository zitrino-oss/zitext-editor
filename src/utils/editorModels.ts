import monaco from '../monaco-config';
import { modelUriForTab } from './editorModelIdentity';
export { modelUriForTab } from './editorModelIdentity';

export function getModelForTab(tabId: string) {
    return monaco.editor.getModel(monaco.Uri.parse(modelUriForTab(tabId)));
}

export function disposeModelForTab(tabId: string): void {
    getModelForTab(tabId)?.dispose();
}
