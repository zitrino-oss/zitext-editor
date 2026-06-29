interface BreadcrumbProps {
    path: string | null;
    onRevealInExplorer?: () => void;
}

export function Breadcrumb({ path, onRevealInExplorer }: BreadcrumbProps) {
    if (!path) return null;

    const parts = path.split(/[/\\]/);
    // Show last 3 segments to avoid overflow on deep paths
    const maxParts = 4;
    const truncated = parts.length > maxParts;
    const visibleParts = truncated ? parts.slice(-(maxParts)) : parts;

    return (
        <div className="breadcrumb" title={path}>
            {truncated && (
                <>
                    <span className="breadcrumb-ellipsis">…</span>
                    <span className="breadcrumb-sep">/</span>
                </>
            )}
            {visibleParts.map((part, i) => {
                const isLast = i === visibleParts.length - 1;
                return (
                    <span key={i} className="breadcrumb-item-wrapper">
                        {i > 0 && <span className="breadcrumb-sep">/</span>}
                        <span
                            className={`breadcrumb-item ${isLast ? 'breadcrumb-item-active' : 'breadcrumb-item-dir'}`}
                            onClick={isLast && onRevealInExplorer ? onRevealInExplorer : undefined}
                        >
                            {part}
                        </span>
                    </span>
                );
            })}
        </div>
    );
}
