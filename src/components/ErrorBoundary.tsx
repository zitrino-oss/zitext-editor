import React, { Component, ReactNode } from 'react';
import { errorService } from '../services/ErrorService';
import '../styles/ErrorBoundary.css';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: React.ErrorInfo | null;
}

/**
 * ErrorBoundary - Catches React component errors and prevents full app crashes
 * 
 * Provides a fallback UI when errors occur and logs errors for debugging.
 */
export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
        };
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        // Log error details
        console.error('React Error Boundary caught an error:', error, errorInfo);

        // Update state with error info
        this.setState({
            error,
            errorInfo,
        });

        // Show toast notification
        errorService.showError(
            'Application error occurred. Please try refreshing the page.',
            error
        );

        // Hook point for forwarding errors to an external tracking service.
    }

    handleReset = (): void => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
        });
    };

    render(): ReactNode {
        if (this.state.hasError) {
            return (
                <div className="error-boundary">
                    <div className="error-boundary-content">
                        <div className="error-boundary-icon">⚠️</div>
                        <h1>Something went wrong</h1>
                        <p className="error-boundary-message">
                            The application encountered an unexpected error.
                        </p>

                        {this.state.error && (
                            <details className="error-boundary-details">
                                <summary>Error Details</summary>
                                <pre className="error-boundary-stack">
                                    {this.state.error.toString()}
                                    {this.state.errorInfo?.componentStack}
                                </pre>
                            </details>
                        )}

                        <div className="error-boundary-actions">
                            <button
                                className="error-boundary-btn error-boundary-btn-primary"
                                onClick={this.handleReset}
                            >
                                Try Again
                            </button>
                            <button
                                className="error-boundary-btn error-boundary-btn-secondary"
                                onClick={() => window.location.reload()}
                            >
                                Reload Page
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
