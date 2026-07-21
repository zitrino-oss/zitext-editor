import { useRef, useCallback, useState } from 'react';
import { EditorPanel } from './EditorPanel';
import { MarkdownPreview } from './MarkdownPreview';
import type { Tab, Settings } from '../types';
import type { editor } from 'monaco-editor';
import { modelUriForTab } from '../utils/editorModels';

interface SplitViewProps {
    leftTab: Tab;
    rightTab: Tab | null;
    settings: Settings;
    findKeybinding?: string;
    replaceKeybinding?: string;
    onLeftChange: (content: string) => void;
    onRightChange: (content: string) => void;
    onLeftCursorChange: (line: number, column: number) => void;
    onRightCursorChange: (line: number, column: number) => void;
    onLeftScrollChange: (scrollTop: number, scrollLeft: number) => void;
    onRightScrollChange: (scrollTop: number, scrollLeft: number) => void;
    onLeftSelectionChange?: (length: number) => void;
    onRightSelectionChange?: (length: number) => void;
    onLeftEditorReady: (editor: editor.IStandaloneCodeEditor | null) => void;
    onRightEditorReady: (editor: editor.IStandaloneCodeEditor | null) => void;
    onLeftFocus?: () => void;
    onRightFocus?: () => void;
}

const MIN_PERCENT = 15;
const MAX_PERCENT = 85;

export function SplitView({
    leftTab,
    rightTab,
    settings,
    findKeybinding,
    replaceKeybinding,
    onLeftChange,
    onRightChange,
    onLeftCursorChange,
    onRightCursorChange,
    onLeftScrollChange,
    onRightScrollChange,
    onLeftSelectionChange,
    onRightSelectionChange,
    onLeftEditorReady,
    onRightEditorReady,
    onLeftFocus,
    onRightFocus,
}: SplitViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [leftPercent, setLeftPercent] = useState(50);
    const [isResizing, setIsResizing] = useState(false);

    const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);

        const onMouseMove = (ev: MouseEvent) => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const pct = ((ev.clientX - rect.left) / rect.width) * 100;
            setLeftPercent(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, pct)));
        };

        const onMouseUp = () => {
            setIsResizing(false);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }, []);

    return (
        <div
            ref={containerRef}
            className={`split-view${isResizing ? ' resizing' : ''}`}
        >
            <div
                className="split-pane split-pane-left"
                style={{ flex: `0 0 ${leftPercent}%` }}
            >
                <div className="split-pane-label" title={leftTab.path || leftTab.title}>
                    {leftTab.isDirty && <span className="split-pane-dirty">●</span>}
                    {leftTab.title}
                </div>
                {leftTab.isPreview ? (
                    <MarkdownPreview content={leftTab.content} theme={settings.theme} />
                ) : (
                    <EditorPanel
                        modelPath={modelUriForTab(leftTab.id)}
                        content={leftTab.content}
                        language={leftTab.language}
                        editorTheme={settings.editorTheme}
                        fontSize={settings.fontSize}
                        fontFamily={settings.fontFamily}
                        wordWrap={settings.wordWrap}
                        showMinimap={settings.showMinimap}
                        isReadOnly={leftTab.isReadOnly}
                        enableColumnSelection={settings.enableColumnSelection}
                        tabSize={settings.tabSize}
                        insertSpaces={settings.insertSpaces}
                        cursorLine={leftTab.cursorLine}
                        cursorColumn={leftTab.cursorColumn}
                        scrollTop={leftTab.scrollTop}
                        scrollLeft={leftTab.scrollLeft}
                        findKeybinding={findKeybinding}
                        replaceKeybinding={replaceKeybinding}
                        onChange={onLeftChange}
                        onCursorChange={onLeftCursorChange}
                        onScrollChange={onLeftScrollChange}
                        onSelectionChange={onLeftSelectionChange}
                        onEditorReady={onLeftEditorReady}
                        onFocus={onLeftFocus}
                    />
                )}
            </div>

            {rightTab && (
                <>
                    <div
                        className="split-divider"
                        onMouseDown={handleDividerMouseDown}
                    />
                    <div className="split-pane split-pane-right" style={{ flex: '1 1 0' }}>
                        <div className="split-pane-label" title={rightTab.path || rightTab.title}>
                            {rightTab.isDirty && <span className="split-pane-dirty">●</span>}
                            {rightTab.title}
                        </div>
                        {rightTab.isPreview ? (
                            <MarkdownPreview content={rightTab.content} theme={settings.theme} />
                        ) : (
                            <EditorPanel
                                modelPath={modelUriForTab(rightTab.id)}
                                content={rightTab.content}
                                language={rightTab.language}
                                editorTheme={settings.editorTheme}
                                fontSize={settings.fontSize}
                                fontFamily={settings.fontFamily}
                                wordWrap={settings.wordWrap}
                                showMinimap={settings.showMinimap}
                                isReadOnly={rightTab.isReadOnly}
                                enableColumnSelection={settings.enableColumnSelection}
                                tabSize={settings.tabSize}
                                insertSpaces={settings.insertSpaces}
                                cursorLine={rightTab.cursorLine}
                                cursorColumn={rightTab.cursorColumn}
                                scrollTop={rightTab.scrollTop}
                                scrollLeft={rightTab.scrollLeft}
                                findKeybinding={findKeybinding}
                                replaceKeybinding={replaceKeybinding}
                                onChange={onRightChange}
                                onCursorChange={onRightCursorChange}
                                onScrollChange={onRightScrollChange}
                                onSelectionChange={onRightSelectionChange}
                                onEditorReady={onRightEditorReady}
                                onFocus={onRightFocus}
                            />
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
