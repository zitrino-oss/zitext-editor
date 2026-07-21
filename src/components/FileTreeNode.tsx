import { useState, useEffect } from 'react';
import type { FileNode } from '../types';
import { getFileIconElement } from '../utils/fileIcons';

interface FileTreeNodeProps {
    node: FileNode;
    level: number;
    onClick: (node: FileNode) => void;
    onExpand: (node: FileNode) => void;
    tabIndex?: number;
}

export function FileTreeNode({ node, level, onClick, onExpand, tabIndex = -1 }: FileTreeNodeProps) {
    const [expanded, setExpanded] = useState(node.expanded || false);

    useEffect(() => {
        if (node.expanded !== undefined) setExpanded(node.expanded);
    }, [node.expanded]);

    const handleClick = () => {
        if (node.isDirectory) {
            const newExpanded = !expanded;
            setExpanded(newExpanded);
            if (newExpanded) onExpand(node);
        } else {
            onClick(node);
        }
    };

    const hasChildren = node.isDirectory && node.children && node.children.length > 0;

    return (
        <div className="ft-node">
            <div
                role="treeitem"
                aria-expanded={node.isDirectory ? expanded : undefined}
                tabIndex={tabIndex}
                className={`ft-row ${node.isDirectory ? 'ft-dir' : 'ft-file'}`}
                style={{ paddingLeft: `${level * 16 + 8}px` }}
                onClick={handleClick}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleClick();
                    } else if (event.key === 'ArrowRight' && node.isDirectory && !expanded) {
                        event.preventDefault();
                        setExpanded(true);
                        onExpand(node);
                    } else if (event.key === 'ArrowLeft' && node.isDirectory && expanded) {
                        event.preventDefault();
                        setExpanded(false);
                    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        const tree = event.currentTarget.closest('[role="tree"]');
                        const items = Array.from(tree?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
                        const current = items.indexOf(event.currentTarget);
                        const direction = event.key === 'ArrowDown' ? 1 : -1;
                        const next = items[current + direction];
                        if (next) {
                            items.forEach(item => { item.tabIndex = -1; });
                            next.tabIndex = 0;
                            next.focus();
                        }
                    }
                }}
                title={node.path}
            >
                {/* Indent guides */}
                {level > 0 && Array.from({ length: level }).map((_, i) => (
                    <span key={i} className="ft-guide" style={{ left: `${i * 16 + 16}px` }} />
                ))}

                {/* Chevron for directories */}
                <span className={`ft-chevron ${node.isDirectory ? (expanded ? 'open' : '') : 'hidden'}`}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M6 4l4 4-4 4z"/>
                    </svg>
                </span>

                {/* Icon */}
                <span className="ft-icon">
                    {getFileIconElement(node.name, node.isDirectory, expanded)}
                </span>

                {/* Name */}
                <span className="ft-name">{node.name}</span>
            </div>

            {node.isDirectory && expanded && hasChildren && (
                <div className="ft-children" role="group">
                    {node.children!.map(child => (
                        <FileTreeNode
                            key={child.path}
                            node={child}
                            level={level + 1}
                            onClick={onClick}
                            onExpand={onExpand}
                            tabIndex={-1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
