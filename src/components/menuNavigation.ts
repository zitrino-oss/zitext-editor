/** Return only the enabled items owned by this menu, excluding nested menus. */
export function getDirectEnabledMenuItems(menu: Element): HTMLElement[] {
    return Array.from(menu.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement
        && child.matches('.menu-option, .menu-submenu')
        && !child.classList.contains('disabled')
        && child.getAttribute('aria-disabled') !== 'true'
    );
}

/** Reveal a nested menu and move keyboard focus into its first enabled item. */
export function openKeyboardSubmenu(submenu: HTMLElement): boolean {
    const nested = submenu.querySelector<HTMLElement>(':scope > .menu-dropdown-nested');
    if (!nested) return false;
    submenu.setAttribute('aria-expanded', 'true');
    nested.classList.add('keyboard-open');
    getDirectEnabledMenuItems(nested)[0]?.focus();
    return true;
}
