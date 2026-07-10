import React, { useState, useEffect, useRef } from 'react';
import { errorService } from '../services/ErrorService';

interface GoToLineModalProps {
    isOpen: boolean;
    onClose: () => void;
    onGoToLine: (lineNumber: number) => void;
    maxLine: number;
}

export function GoToLineModal({ isOpen, onClose, onGoToLine, maxLine }: GoToLineModalProps) {
    const [lineNumber, setLineNumber] = useState('');
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
        const num = parseInt(lineNumber);
        const effectiveMax = Math.max(maxLine, 1); // treat empty file as 1 line
        if (!isNaN(num) && num > 0 && num <= effectiveMax) {
            onGoToLine(num);
            onClose();
        } else {
            errorService.showWarning(`Please enter a line number between 1 and ${effectiveMax}`);
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
                    <h3>Go to Line</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>
                {/* noValidate: rely on handleSubmit's JS range check + in-app warning
                    toast instead of native HTML5 constraint validation. WebKitGTK
                    (Linux) renders the native validation bubble empty, and it also
                    blocks submit so our own message never showed. */}
                <form noValidate onSubmit={handleSubmit}>
                    <div className="modal-body">
                        <input
                            ref={inputRef}
                            type="number"
                            className="modal-input"
                            placeholder={`Line number (1-${Math.max(maxLine, 1)})`}
                            value={lineNumber}
                            onChange={(e) => setLineNumber(e.target.value)}
                            min="1"
                            max={Math.max(maxLine, 1)}
                        />
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="modal-button" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="modal-button primary">
                            Go
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
