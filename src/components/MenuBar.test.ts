// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fitSubmenuToViewport, getDirectEnabledMenuItems, openKeyboardSubmenu } from './menuNavigation';

describe('menubar keyboard navigation', () => {
    it('does not mix hidden nested options into a parent menu sequence', () => {
        const menu = document.createElement('div');
        menu.innerHTML = `
            <div class="menu-option">Open</div>
            <div class="menu-submenu">Recent
                <div class="menu-dropdown-nested">
                    <div class="menu-option">Nested file</div>
                </div>
            </div>
            <div class="menu-divider"></div>
            <div class="menu-option disabled">Disabled</div>
            <div class="menu-option">Close</div>
        `;

        expect(getDirectEnabledMenuItems(menu).map(item => item.textContent?.trim().split('\n')[0]))
            .toEqual(['Open', 'Recent', 'Close']);
    });

    it('reveals a submenu and moves keyboard focus into it', () => {
        const submenu = document.createElement('div');
        submenu.className = 'menu-submenu';
        submenu.innerHTML = `
            Language
            <div class="menu-dropdown-nested">
                <div class="menu-option" tabindex="0">HTML</div>
                <div class="menu-option" tabindex="0">CSS</div>
            </div>
        `;
        document.body.appendChild(submenu);

        expect(openKeyboardSubmenu(submenu)).toBe(true);
        expect(submenu.getAttribute('aria-expanded')).toBe('true');
        expect(submenu.querySelector('.menu-dropdown-nested')?.classList)
            .toContain('keyboard-open');
        expect(document.activeElement?.textContent).toBe('HTML');

        submenu.remove();
    });

    it('shifts a submenu up and caps its height to stay inside the window', () => {
        const style = document.createElement('style');
        style.textContent = '.menu-dropdown-nested { top: -5px; }';
        document.head.appendChild(style);
        const nested = document.createElement('div');
        nested.className = 'menu-dropdown-nested';
        document.body.appendChild(nested);
        const rectAt = (top: number, height: number) => () => ({ top, height } as DOMRect);
        const innerHeight = window.innerHeight;
        Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

        nested.getBoundingClientRect = rectAt(400, 300);
        expect(fitSubmenuToViewport(nested)).toBe(true);
        expect(nested.style.top).toBe('-113px');
        expect(nested.style.maxHeight).toBe('');

        nested.getBoundingClientRect = rectAt(100, 900);
        fitSubmenuToViewport(nested);
        expect(nested.style.maxHeight).toBe('584px');
        expect(nested.style.overflowY).toBe('auto');

        nested.getBoundingClientRect = rectAt(0, 0);
        expect(fitSubmenuToViewport(nested)).toBe(false);

        Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
        nested.remove();
        style.remove();
    });
});
