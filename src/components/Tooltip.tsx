import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/* Delay before showing, so moving the pointer across a row of buttons doesn't
   flash a tooltip over each one on the way past. */
const OPEN_DELAY_MS = 400;
const GAP = 6;
const VIEWPORT_MARGIN = 8;

interface TooltipProps {
    label: string;
    children: ReactNode;
}

/**
 * Tooltip - a styled replacement for the native `title` attribute.
 *
 * Rendered through a portal into <body> rather than next to the trigger, and
 * positioned with `position: fixed` from the trigger's own rect. That is the
 * point of the component: the tab-bar buttons that use it sit inside
 * `.tab-bar`, which is 36px tall with `overflow-y: hidden`, so a tooltip in the
 * normal flow — a CSS ::after included — would be clipped the moment it
 * extended below the strip.
 */
export function Tooltip({ label, children }: TooltipProps) {
    const hostRef = useRef<HTMLSpanElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<number | undefined>(undefined);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const [left, setLeft] = useState<number | null>(null);

    const hide = useCallback(() => {
        window.clearTimeout(timerRef.current);
        setPos(null);
        setLeft(null);
    }, []);

    const show = useCallback(() => {
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
            const host = hostRef.current;
            if (!host) return;
            const r = host.getBoundingClientRect();
            setPos({ top: r.bottom + GAP, left: r.left + r.width / 2 });
        }, OPEN_DELAY_MS);
    }, []);

    // A pending timer outliving the component would set state after unmount.
    useEffect(() => () => window.clearTimeout(timerRef.current), []);

    /* Keep it inside the window. The tooltip is centred on its trigger, and the
       triggers this was built for sit hard against the right edge of the tab
       bar — centred there, half the tooltip would hang off-screen. The width
       isn't known until it has rendered, so measure and nudge before paint. */
    useLayoutEffect(() => {
        const tip = tipRef.current;
        if (!pos || !tip) return;
        const half = tip.offsetWidth / 2;
        const min = VIEWPORT_MARGIN + half;
        const max = window.innerWidth - VIEWPORT_MARGIN - half;
        // max < min only when the tooltip is wider than the window; clamping to
        // min then keeps the start of the text visible rather than the middle.
        setLeft(Math.max(min, Math.min(pos.left, Math.max(min, max))));
    }, [pos]);

    // Anything that moves the trigger out from under the tooltip dismisses it:
    // the position is a snapshot, so it would otherwise hang in mid-air.
    useEffect(() => {
        if (!pos) return;
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [pos, hide]);

    return (
        <span
            ref={hostRef}
            className="tip-host"
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={show}
            onBlur={hide}
        >
            {children}
            {pos && createPortal(
                <div
                    ref={tipRef}
                    className="tip"
                    role="tooltip"
                    style={{ top: pos.top, left: left ?? pos.left }}
                >
                    {label}
                </div>,
                document.body,
            )}
        </span>
    );
}
