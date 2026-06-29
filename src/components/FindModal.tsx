import React, { useState, useEffect, useRef } from 'react';

interface FindModalProps {
    isOpen: boolean;
    onClose: () => void;
    onFind: (searchText: string, caseSensitive: boolean) => void;
}

export function FindModal({ isOpen, onClose, onFind }: FindModalProps) {
    const [searchTerm, setSearchTerm] = useState<string>('');
    const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (searchTerm.trim()) {
            onFind(searchTerm, caseSensitive);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
                <div className="modal-header">
                    <h3>Find</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>
                <form onSubmit={handleSubmit}>
                    <div className="modal-body">
                        <input
                            ref={inputRef}
                            type="text"
                            className="modal-input"
                            placeholder="Find..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                        <label className="modal-checkbox">
                            <input
                                type="checkbox"
                                checked={caseSensitive}
                                onChange={(e) => setCaseSensitive(e.target.checked)}
                            />
                            Case sensitive
                        </label>
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="modal-button" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="modal-button primary">
                            Find
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
