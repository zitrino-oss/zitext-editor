import { useRef, useCallback, useState, useEffect } from 'react';
import { EditorPanel } from './EditorPanel';
import { LazyMarkdownPreview as MarkdownPreview } from './LazyMarkdownPreview';
import { PaneErrorBoundary } from './PaneErrorBoundary';
import type { Tab, Settings } from '../types';
import type { editor } from 'monaco-editor';
import { isJsoncPath, showsPreview } from '../utils/languages';
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
    /** Opens a Markdown preview's relative link target as a tab. */
    onOpenFile?: (path: string) => void;
    /** Rendered preview bodies, so Find can search a previewed pane. */
    leftPreviewRef?: React.Ref<HTMLDivElement>;
    rightPreviewRef?: React.Ref<HTMLDivElement>;
    /** The pane that last had focus. */
    activePane?: 'left' | 'right';
}

interface PaneView { line: number; column: number; top: number; left: number }
const viewOf = (tab: Tab): PaneView => ({ line: tab.cursorLine, column: tab.cursorColumn, top: tab.scrollTop, left: tab.scrollLeft });

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
    onOpenFile,
    leftPreviewRef,
    rightPreviewRef,
    activePane = 'left',
}: SplitViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [leftPercent, setLeftPercent] = useState(50);

    // The same tab in both panes: the right pane keeps its own cursor and
    // scroll position, so two parts of one file can be viewed at once.
    // The tab's stored position stays the left pane's.
    const mirrored = rightTab !== null && rightTab.id === leftTab.id;
    const [mirrorView, setMirrorView] = useState<PaneView | null>(null);
    const rightTabId = rightTab?.id;
    useEffect(() => {
        setMirrorView(mirrored && rightTab ? viewOf(rightTab) : null);
        // Only when mirroring starts or the right tab changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mirrored, rightTabId]);
    // A reveal (search result, Go to Line) moves both views to the target.
    const revealRequest = rightTab?.revealRequest;
    useEffect(() => {
        if (mirrored && rightTab && revealRequest !== undefined) setMirrorView(view => view && { ...view, line: rightTab.cursorLine, column: rightTab.cursorColumn });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revealRequest]);
    const rightView = mirrored && mirrorView ? mirrorView : rightTab ? viewOf(rightTab) : null;
    const handleRightCursor = mirrored
        ? (line: number, column: number) => setMirrorView(view => view && { ...view, line, column })
        : onRightCursorChange;
    const handleRightScroll = mirrored
        ? (top: number, left: number) => setMirrorView(view => view && { ...view, top, left })
        : onRightScrollChange;
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
            {/* Pointer-down marks the pane active even when it shows a preview
                (which has no editor to report focus), so Find targets it. */}
            <div
                className="split-pane split-pane-left"
                style={{ flex: `0 0 ${leftPercent}%` }}
                onMouseDownCapture={onLeftFocus}
            >
                <div className="split-pane-label" title={leftTab.path || leftTab.title}>
                    {leftTab.isDirty && <span className="split-pane-dirty">●</span>}
                    {leftTab.title}
                </div>
                <PaneErrorBoundary resetKey={`${leftTab.id}|${showsPreview(leftTab) ? 'preview' : 'editor'}`}>
                {showsPreview(leftTab) ? (
                    <MarkdownPreview content={leftTab.content} documentPath={leftTab.path} onOpenFile={onOpenFile} bodyRef={leftPreviewRef} />
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
                        allowJsonComments={isJsoncPath(leftTab.path)}
                        isActivePane={activePane === 'left'}
                        revealRequest={leftTab.revealRequest}
                        onChange={onLeftChange}
                        onCursorChange={onLeftCursorChange}
                        onScrollChange={onLeftScrollChange}
                        onSelectionChange={onLeftSelectionChange}
                        onEditorReady={onLeftEditorReady}
                        onFocus={onLeftFocus}
                    />
                )}
                </PaneErrorBoundary>
            </div>

            {rightTab && (
                <>
                    {/* Also resizable from the keyboard (arrow keys, Home/End). */}
                    <div
                        className="split-divider"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize split panes"
                        aria-valuemin={MIN_PERCENT}
                        aria-valuemax={MAX_PERCENT}
                        aria-valuenow={Math.round(leftPercent)}
                        tabIndex={0}
                        onMouseDown={handleDividerMouseDown}
                        onKeyDown={(e) => {
                            const step = e.shiftKey ? 10 : 2;
                            const next = e.key === 'ArrowLeft' ? leftPercent - step
                                : e.key === 'ArrowRight' ? leftPercent + step
                                : e.key === 'Home' ? MIN_PERCENT
                                : e.key === 'End' ? MAX_PERCENT
                                : null;
                            if (next === null) return;
                            e.preventDefault();
                            setLeftPercent(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, next)));
                        }}
                    />
                    <div className="split-pane split-pane-right" style={{ flex: '1 1 0' }} onMouseDownCapture={onRightFocus}>
                        <div className="split-pane-label" title={rightTab.path || rightTab.title}>
                            {rightTab.isDirty && <span className="split-pane-dirty">●</span>}
                            {rightTab.title}
                        </div>
                        <PaneErrorBoundary resetKey={`${rightTab.id}|${showsPreview(rightTab) ? 'preview' : 'editor'}`}>
                        {showsPreview(rightTab) ? (
                            <MarkdownPreview content={rightTab.content} documentPath={rightTab.path} onOpenFile={onOpenFile} bodyRef={rightPreviewRef} />
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
                                cursorLine={rightView?.line ?? rightTab.cursorLine}
                                cursorColumn={rightView?.column ?? rightTab.cursorColumn}
                                scrollTop={rightView?.top ?? rightTab.scrollTop}
                                scrollLeft={rightView?.left ?? rightTab.scrollLeft}
                                findKeybinding={findKeybinding}
                                replaceKeybinding={replaceKeybinding}
                                allowJsonComments={isJsoncPath(rightTab.path)}
                                isActivePane={activePane === 'right'}
                                revealRequest={rightTab.revealRequest}
                                onChange={onRightChange}
                                onCursorChange={handleRightCursor}
                                onScrollChange={handleRightScroll}
                                onSelectionChange={onRightSelectionChange}
                                onEditorReady={onRightEditorReady}
                                onFocus={onRightFocus}
                            />
                        )}
                        </PaneErrorBoundary>
                    </div>
                </>
            )}
        </div>
    );
}
