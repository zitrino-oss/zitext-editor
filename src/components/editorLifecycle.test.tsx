// @vitest-environment jsdom
/**
 * Editor models belong to tabs, not to editor
 * views. A pane unmounting (preview toggle, split/single switch) must not
 * dispose a model, closing a tab must not dispose a model an editor still
 * shows, and a crash in an editor pane must stay in that pane.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
    class FakeModel {
        disposed = false;
        dispose() { this.disposed = true; }
        isDisposed() { return this.disposed; }
    }
    const models = new Map<string, FakeModel>();
    const editors: { getModel: () => FakeModel | null }[] = [];
    const editorProps: Record<string, unknown>[] = [];
    return { FakeModel, models, editors, editorProps };
});

vi.mock('../monaco-config', () => ({
    default: {
        Uri: { parse: (uri: string) => uri },
        editor: {
            getModel: (uri: string) => fake.models.get(uri) ?? null,
            getEditors: () => fake.editors,
        },
    },
}));
vi.mock('monaco-editor', () => ({ editor: { ScrollType: { Immediate: 1 } } }));
vi.mock('@monaco-editor/react', () => ({
    default: (props: Record<string, unknown>) => {
        fake.editorProps.push(props);
        return null;
    },
}));
vi.mock('../utils/editorCommands', () => ({
    copySelection: vi.fn(), cutSelection: vi.fn(), pasteFromClipboard: vi.fn(),
}));

import { EditorPanel } from './EditorPanel';
import { PaneErrorBoundary } from './PaneErrorBoundary';
import { disposeModelForTab, modelUriForTab } from '../utils/editorModels';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | undefined;
function render(node: React.ReactNode) {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(node));
    unmount = () => act(() => root.unmount());
    return { host, rerender: (next: React.ReactNode) => act(() => root.render(next)) };
}

beforeEach(() => {
    fake.models.clear();
    fake.editors.length = 0;
    fake.editorProps.length = 0;
});
afterEach(() => { unmount?.(); unmount = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('editor model ownership', () => {
    it('the editor view never disposes its model when it unmounts', () => {
        render(
            <EditorPanel
                modelPath="inmemory://tab/1" content="x" language="plaintext" editorTheme="vs"
                fontSize={14} fontFamily="monospace" wordWrap={false} showMinimap={false}
                isReadOnly={false} enableColumnSelection={false} tabSize={4} insertSpaces
                cursorLine={1} cursorColumn={1} scrollTop={0} scrollLeft={0}
                onChange={() => {}} onCursorChange={() => {}}
            />,
        );
        expect(fake.editorProps[fake.editorProps.length - 1]?.keepCurrentModel).toBe(true);
    });

    it('closing a tab waits until no editor shows its model before disposing it', () => {
        vi.useFakeTimers();
        const model = new fake.FakeModel();
        fake.models.set(modelUriForTab('t1'), model);
        let shown: InstanceType<typeof fake.FakeModel> | null = model;
        fake.editors.push({ getModel: () => shown });

        disposeModelForTab('t1');
        vi.advanceTimersByTime(200);
        expect(model.disposed).toBe(false); // still attached to an editor

        shown = null; // the editor switched to another tab's model
        vi.advanceTimersByTime(100);
        expect(model.disposed).toBe(true);
    });
});

describe('PaneErrorBoundary', () => {
    function Boom({ fail }: { fail: boolean }) {
        if (fail) throw new Error('editor exploded');
        return <span className="pane-ok">editor</span>;
    }

    it('contains a crash to the pane and recovers when the tab changes', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const view = (fail: boolean, key: string) => (
            <div>
                <span className="outside">tabs and menus</span>
                <PaneErrorBoundary resetKey={key}><Boom fail={fail} /></PaneErrorBoundary>
            </div>
        );
        const { host, rerender } = render(view(true, 'tab-a'));
        expect(host.querySelector('.pane-error')).not.toBeNull();
        expect(host.querySelector('.outside')).not.toBeNull();

        rerender(view(false, 'tab-b'));
        expect(host.querySelector('.pane-error')).toBeNull();
        expect(host.querySelector('.pane-ok')).not.toBeNull();
    });

    it('"Reopen editor" re-renders the pane', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let fail = true;
        function Flaky() {
            if (fail) throw new Error('once');
            return <span className="pane-ok">editor</span>;
        }
        const { host } = render(<PaneErrorBoundary resetKey="a"><Flaky /></PaneErrorBoundary>);
        fail = false;
        act(() => (host.querySelector('.pane-error-button') as HTMLButtonElement).click());
        expect(host.querySelector('.pane-ok')).not.toBeNull();
    });
});
