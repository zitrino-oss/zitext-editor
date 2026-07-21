export function modelUriForTab(tabId: string): string {
    return `zitext://document/${encodeURIComponent(tabId)}`;
}
