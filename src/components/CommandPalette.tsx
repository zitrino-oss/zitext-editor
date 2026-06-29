import { useState, useEffect, useRef } from 'react';

interface Command {
    id: string;
    label: string;
    description: string;
    action: () => void;
    category: string;
}

interface CommandPaletteProps {
    isOpen: boolean;
    onClose: () => void;
    commands: Command[];
}

export function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
    const [search, setSearch] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    const filteredCommands = commands.filter(cmd =>
        cmd.label.toLowerCase().includes(search.toLowerCase()) ||
        cmd.description.toLowerCase().includes(search.toLowerCase()) ||
        cmd.category.toLowerCase().includes(search.toLowerCase())
    );

    useEffect(() => {
        setSelectedIndex(prev => Math.min(prev, Math.max(0, filteredCommands.length - 1)));
    }, [filteredCommands.length]);

    useEffect(() => {
        if (isOpen) {
            setSearch('');
            setSelectedIndex(0);
        }
    }, [isOpen]);

    // Scroll selected item into view
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const item = list.children[selectedIndex] as HTMLElement | undefined;
        item?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter' && filteredCommands[selectedIndex]) {
            e.preventDefault();
            filteredCommands[selectedIndex].action();
            onClose();
        }
    };

    const handleCommandClick = (command: Command) => {
        command.action();
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="cp-overlay" onClick={onClose}>
            <div className="cp-container" onClick={(e) => e.stopPropagation()}>
                <div className="cp-search-row">
                    <svg className="cp-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                    </svg>
                    <input
                        type="text"
                        className="cp-input"
                        placeholder="Type a command..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoFocus
                    />
                    <kbd className="cp-hint">esc</kbd>
                </div>
                <div className="cp-results" ref={listRef}>
                    {filteredCommands.length === 0 ? (
                        <div className="cp-empty">No matching commands</div>
                    ) : (
                        filteredCommands.map((command, index) => (
                            <div
                                key={command.id}
                                className={`cp-item ${index === selectedIndex ? 'selected' : ''}`}
                                onClick={() => handleCommandClick(command)}
                                onMouseEnter={() => setSelectedIndex(index)}
                            >
                                <span className="cp-item-label">{command.label}</span>
                                <span className="cp-item-cat">{command.category}</span>
                            </div>
                        ))
                    )}
                </div>
                {filteredCommands.length > 0 && (
                    <div className="cp-footer">
                        <span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> navigate</span>
                        <span><kbd>&crarr;</kbd> select</span>
                    </div>
                )}
            </div>
        </div>
    );
}
