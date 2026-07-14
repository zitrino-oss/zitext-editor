import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Tab } from '../types';
import { FileIcon } from '../utils/fileIcons';

interface TabBarProps {
    tabs: Tab[];
    activeTabId: string | null;
    onTabClick: (tabId: string) => void;
    onTabClose: (tabId: string) => void;
    onNewTab: () => void;
    onReorder: (startIndex: number, endIndex: number) => void;
    onRename: (tabId: string, newName: string) => void;
    onPinToggle: (tabId: string) => void;
}

interface TabItemProps {
    tab: Tab;
    isActive: boolean;
    /** True while this tab is the drag source — renders invisible (keeps its space). */
    isSource: boolean;
    /** translateX pixels applied via CSS transition for live-shift animation. */
    shift: number;
    index: number;
    onClick: () => void;
    onClose: () => void;
    onMouseDown: (e: React.MouseEvent, index: number) => void;
    onRename: (tabId: string, newName: string) => void;
    onPinToggle: (tabId: string) => void;
}

function TabItem({
    tab,
    isActive,
    isSource,
    shift,
    index,
    onClick,
    onClose,
    onMouseDown,
    onRename,
    onPinToggle,
}: TabItemProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(tab.title);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!isEditing) setEditValue(tab.title);
    }, [tab.title, isEditing]);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    const handleDoubleClick = () => {
        setEditValue(tab.title);
        setIsEditing(true);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { onRename(tab.id, editValue); setIsEditing(false); }
        else if (e.key === 'Escape') { setIsEditing(false); }
    };

    const handleBlur = () => {
        if (isEditing) { onRename(tab.id, editValue); setIsEditing(false); }
    };

    return (
        <div
            role="tab"
            aria-selected={isActive}
            aria-controls="editor-workspace"
            tabIndex={isActive ? 0 : -1}
            className={`tab ${isActive ? 'active' : ''} ${isSource ? 'tab-source' : ''} ${tab.isPinned ? 'pinned' : ''}`}
            style={{ transform: shift !== 0 ? `translateX(${shift}px)` : undefined }}
            onClick={onClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onClick();
                } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    const tabs = Array.from(
                        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
                    );
                    const current = tabs.indexOf(event.currentTarget);
                    const direction = event.key === 'ArrowRight' ? 1 : -1;
                    const next = tabs[(current + direction + tabs.length) % tabs.length];
                    next?.focus();
                    next?.click();
                } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    const tabs = Array.from(
                        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
                    );
                    const next = event.key === 'Home' ? tabs[0] : tabs[tabs.length - 1];
                    next?.focus();
                    next?.click();
                }
            }}
            onMouseDown={(e) => {
                if (isEditing || tab.isPinned) return;
                if ((e.target as HTMLElement).closest('button')) return;
                onMouseDown(e, index);
            }}
            title={tab.path || tab.title}
        >
            <span className="tab-icon" aria-hidden="true"><FileIcon name={tab.title} /></span>
            <span className="tab-name">
                {tab.isDirty && <span className="dirty-indicator" title="Unsaved changes">●</span>}
                {isEditing ? (
                    <input
                        ref={inputRef}
                        type="text"
                        className="tab-rename-input"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onBlur={handleBlur}
                        onClick={(e) => e.stopPropagation()}
                    />
                ) : (
                    tab.title
                )}
            </span>
            <button
                className="tab-pin"
                title={tab.isPinned ? 'Unpin tab' : 'Pin tab'}
                onClick={(e) => { e.stopPropagation(); onPinToggle(tab.id); }}
            >
                {tab.isPinned ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                    </svg>
                ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="17" x2="12" y2="22"/>
                        <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z"/>
                    </svg>
                )}
            </button>
            {!tab.isPinned && (
                <button
                    className="tab-close"
                    title="Close Tab"
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                >
                    ×
                </button>
            )}
        </div>
    );
}

export function TabBar({ tabs, activeTabId, onTabClick, onTabClose, onNewTab, onReorder, onRename, onPinToggle }: TabBarProps) {
    const tabBarRef = useRef<HTMLDivElement>(null);
    const floatRef = useRef<HTMLDivElement>(null);
    const onReorderRef = useRef(onReorder);
    useEffect(() => { onReorderRef.current = onReorder; }, [onReorder]);

    // All hot-path drag data lives in refs — no re-renders on every pixel of movement.
    const dragInfo = useRef<{
        sourceIndex: number;
        grabOffset: number;   // how far from tab left edge the mouse was grabbed
        startX: number;       // mouseX at mousedown — used for the movement threshold
        tabWidth: number;
        tabHeight: number;
        floatTop: number;     // fixed-Y for the ghost
        active: boolean;      // true once the 5px threshold is crossed
        /** Natural (pre-transform) tab positions captured at drag-start.
         *  Keeping these fixed prevents a feedback loop where CSS-shifted tabs
         *  affect computeDrop, which causes chaotic 2-slot jumps. */
        naturalPositions: { left: number; width: number }[];
    } | null>(null);

    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);

    // ---------------------------------------------------------------------------
    // Handler logic lives in a ref so it is ALWAYS current.
    //
    // React Fast Refresh (HMR) does NOT re-run useEffect(() => …, []).  If the
    // handlers were defined inside the effect they would be stale closures after
    // every hot-reload, causing old logic (e.g., reordering on plain clicks) to
    // persist until a full page refresh.  Indirecting through a ref means the
    // effect only manages listener lifecycle while the logic itself is updated
    // on every render.
    // ---------------------------------------------------------------------------
    const moveHandlerRef = useRef<(e: MouseEvent) => void>(null!);
    const upHandlerRef   = useRef<(e: MouseEvent) => void>(null!);

    // Stable ref for current drop index — lets the move handler apply hysteresis
    // without depending on React state (which lags by one render).
    const dropIndexRef = useRef<number | null>(null);

    // Nearest-slot algorithm using natural positions captured at drag-start.
    // "Closest centre" keeps computeDrop stable: a stationary click always maps
    // back to sourceIndex, and CSS-shifted tab positions can't feed back.
    const computeDrop = (mouseX: number, sourceIdx: number): number => {
        const info = dragInfo.current;
        if (!info || info.naturalPositions.length === 0) return sourceIdx;

        const floatCenter = mouseX - info.grabOffset + info.tabWidth / 2;
        let bestDist = Infinity;
        let drop = sourceIdx;

        for (let i = 0; i < info.naturalPositions.length; i++) {
            const pos = info.naturalPositions[i];
            const dist = Math.abs(floatCenter - (pos.left + pos.width / 2));
            if (dist < bestDist) { bestDist = dist; drop = i; }
        }
        return drop;
    };

    // Reassign on every render so the effect closure always delegates to fresh logic.
    moveHandlerRef.current = (e: MouseEvent) => {
        const info = dragInfo.current;
        if (!info) return;

        // Wait for at least 5px horizontal movement before activating the drag.
        if (!info.active) {
            if (Math.abs(e.clientX - info.startX) < 5) return;
            info.active = true;
            dropIndexRef.current = info.sourceIndex;
            const cx = e.clientX;
            setDraggedIndex(info.sourceIndex);
            setDropIndex(info.sourceIndex);
            // Seed the ghost position after React mounts the portal element.
            requestAnimationFrame(() => {
                if (floatRef.current && dragInfo.current) {
                    const d = dragInfo.current;
                    floatRef.current.style.left   = `${cx - d.grabOffset}px`;
                    floatRef.current.style.top    = `${d.floatTop}px`;
                    floatRef.current.style.width  = `${d.tabWidth}px`;
                    floatRef.current.style.height = `${d.tabHeight}px`;
                }
            });
            return;
        }

        // Directly update ghost X — no React state, no re-render.
        if (floatRef.current) floatRef.current.style.left = `${e.clientX - info.grabOffset}px`;

        // Hysteresis: the ghost must cross 15% of a tab-width past the slot midpoint
        // before we commit to the new slot.  This prevents rapid back-and-forth
        // "flicker" when hovering near a boundary, giving Chrome-style smoothness.
        const rawDrop  = computeDrop(e.clientX, info.sourceIndex);
        const prevDrop = dropIndexRef.current ?? info.sourceIndex;

        if (rawDrop !== prevDrop) {
            const floatCenter  = e.clientX - info.grabOffset + info.tabWidth / 2;
            const hysteresis   = info.tabWidth * 0.15;
            const fromCenter   = info.naturalPositions[prevDrop]?.left  + (info.naturalPositions[prevDrop]?.width  ?? 0) / 2;
            const toCenter     = info.naturalPositions[rawDrop]?.left   + (info.naturalPositions[rawDrop]?.width   ?? 0) / 2;
            const midpoint     = (fromCenter + toCenter) / 2;
            const shouldCommit = rawDrop > prevDrop
                ? floatCenter > midpoint + hysteresis   // moving right
                : floatCenter < midpoint - hysteresis;  // moving left

            if (shouldCommit) {
                dropIndexRef.current = rawDrop;
                setDropIndex(rawDrop);
            }
        }
    };

    upHandlerRef.current = (e: MouseEvent) => {
        const info = dragInfo.current;
        if (!info) return;

        const wasActive = info.active;
        // On mouseup use raw computeDrop (no hysteresis) so the final position
        // matches where the ghost actually is when the user releases.
        const finalDrop = wasActive ? computeDrop(e.clientX, info.sourceIndex) : info.sourceIndex;
        dragInfo.current = null;
        dropIndexRef.current = null;

        // A plain click (threshold never crossed) must not trigger a reorder.
        if (!wasActive) return;

        setDraggedIndex(null);
        setDropIndex(null);
        if (finalDrop !== info.sourceIndex) {
            onReorderRef.current(info.sourceIndex, finalDrop);
        }
    };

    // Register listeners once; delegate to the always-fresh handler refs.
    useEffect(() => {
        const onMove = (e: MouseEvent) => moveHandlerRef.current(e);
        const onUp   = (e: MouseEvent) => upHandlerRef.current(e);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup',   onUp);
        };
    }, []);

    const handleMouseDown = useCallback((e: React.MouseEvent, index: number) => {
        if (e.button !== 0) return;
        e.preventDefault();

        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();

        // Capture natural (untransformed) tab positions before any CSS transforms.
        // querySelectorAll inside tabBarRef never picks up the portal ghost.
        const tabEls = tabBarRef.current?.querySelectorAll<HTMLElement>('.tab') ?? [];
        const naturalPositions = Array.from(tabEls).map(el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, width: r.width };
        });

        dragInfo.current = {
            sourceIndex: index,
            grabOffset: e.clientX - rect.left,
            startX: e.clientX,
            tabWidth: rect.width,
            tabHeight: rect.height,
            floatTop: rect.top,
            active: false,
            naturalPositions,
        };
        // setDraggedIndex is intentionally deferred to moveHandlerRef
        // so a plain click never shows a ghost or triggers a re-render.
    }, []);

    /**
     * Per-tab lateral shift so remaining tabs slide to show where the dragged
     * tab will land.  Only called during an active drag.
     */
    const getShift = (index: number): number => {
        if (draggedIndex === null || dropIndex === null) return 0;
        const w = dragInfo.current?.tabWidth ?? 0;
        if (!w || index === draggedIndex) return 0;

        if (draggedIndex < dropIndex) {
            // Moving right → tabs between src+1 … dst shift left
            if (index > draggedIndex && index <= dropIndex) return -w;
        } else {
            // Moving left → tabs between dst … src-1 shift right
            if (index >= dropIndex && index < draggedIndex) return w;
        }
        return 0;
    };

    const isDragging = draggedIndex !== null;
    const ghostTab   = isDragging ? tabs[draggedIndex!] : null;

    return (
        <>
            <div
                className={`tab-bar${isDragging ? ' dragging' : ''}`}
                ref={tabBarRef}
                role="tablist"
                aria-label="Open files"
            >
                {tabs.map((tab, index) => (
                    <TabItem
                        key={tab.id}
                        tab={tab}
                        isActive={tab.id === activeTabId}
                        isSource={draggedIndex === index}
                        shift={getShift(index)}
                        index={index}
                        onClick={() => !isDragging && onTabClick(tab.id)}
                        onClose={() => onTabClose(tab.id)}
                        onMouseDown={handleMouseDown}
                        onRename={onRename}
                        onPinToggle={onPinToggle}
                    />
                ))}
                <button className="tab-new" onClick={onNewTab} title="New File (Cmd+N)">+</button>
            </div>

            {/* Ghost tab rendered in a portal so it escapes tab-bar overflow:hidden.
                We portal into .app (not document.body) so the ghost inherits the
                correct CSS custom-property theme (light vs dark). position:fixed
                still makes it viewport-anchored regardless of overflow. */}
            {isDragging && ghostTab && createPortal(
                <div
                    ref={floatRef}
                    className={`tab tab-ghost ${ghostTab.id === activeTabId ? 'active' : ''}`}
                    style={{ position: 'fixed', pointerEvents: 'none', zIndex: 9999 }}
                >
                    <span className="tab-icon" aria-hidden="true">
                        <FileIcon name={ghostTab.title} />
                    </span>
                    <span className="tab-name">
                        {ghostTab.isDirty && <span className="dirty-indicator">●</span>}
                        {ghostTab.title}
                    </span>
                </div>,
                document.querySelector('.app') ?? document.body,
            )}
        </>
    );
}
