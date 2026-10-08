import '../styles/ErrorBoundary.css';
import React, { Component, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    /** Changing this (e.g. switching tabs) clears the error and re-renders. */
    resetKey: string;
}

interface State {
    error: Error | null;
}

/**
 * Contains a crash inside an editor pane (Monaco, preview) to that pane.
 *
 * Without it, any error thrown while rendering an editor reached the root
 * error boundary, which unmounts the whole app: every open document's
 * in-memory state, the menus and the close-request handling disappeared.
 * Tab content lives in App state above this boundary, so remounting the pane
 * shows the same documents again with nothing lost.
 */
export class PaneErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        console.error('Editor pane error:', error, info.componentStack);
    }

    componentDidUpdate(previous: Props): void {
        if (this.state.error && previous.resetKey !== this.props.resetKey) {
            this.setState({ error: null });
        }
    }

    private reopen = () => this.setState({ error: null });

    render(): ReactNode {
        if (!this.state.error) return this.props.children;
        return (
            <div className="pane-error" role="alert">
                <p className="pane-error-title">This editor pane ran into a problem.</p>
                <p className="pane-error-text">
                    Your documents are still open and unsaved changes are kept.
                </p>
                <button type="button" className="pane-error-button" onClick={this.reopen}>
                    Reopen editor
                </button>
            </div>
        );
    }
}
