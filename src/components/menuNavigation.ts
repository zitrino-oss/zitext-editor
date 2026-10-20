/** Return only the enabled items owned by this menu, excluding nested menus. */
export function getDirectEnabledMenuItems(menu: Element): HTMLElement[] {
    return Array.from(menu.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement
        && child.matches('.menu-option, .menu-submenu')
        && !child.classList.contains('disabled')
        && child.getAttribute('aria-disabled') !== 'true'
    );
}

const VIEWPORT_MARGIN = 8;

/**
 * Keep an open nested menu inside the window: shift it up when it would run
 * past the bottom edge, and cap its height (scrolling the rest) when the
 * window is shorter than the menu. Returns false while the menu is hidden.
 */
export function fitSubmenuToViewport(nested: HTMLElement): boolean {
    nested.style.top = '';
    nested.style.maxHeight = '';
    nested.style.overflowY = '';

    const rect = nested.getBoundingClientRect();
    if (rect.height === 0) return false;

    const available = window.innerHeight - VIEWPORT_MARGIN * 2;
    let height = rect.height;
    if (height > available) {
        nested.style.maxHeight = `${available}px`;
        nested.style.overflowY = 'auto';
        height = available;
    }

    const overflow = rect.top + height - (window.innerHeight - VIEWPORT_MARGIN);
    if (overflow > 0) {
        const shift = Math.min(overflow, rect.top - VIEWPORT_MARGIN);
        const baseTop = parseFloat(getComputedStyle(nested).top) || 0;
        nested.style.top = `${baseTop - shift}px`;
    }
    return true;
}

/** Reveal a nested menu and move keyboard focus into its first enabled item. */
export function openKeyboardSubmenu(submenu: HTMLElement): boolean {
    const nested = submenu.querySelector<HTMLElement>(':scope > .menu-dropdown-nested');
    if (!nested) return false;
    submenu.setAttribute('aria-expanded', 'true');
    nested.classList.add('keyboard-open');
    fitSubmenuToViewport(nested);
    getDirectEnabledMenuItems(nested)[0]?.focus();
    return true;
}
