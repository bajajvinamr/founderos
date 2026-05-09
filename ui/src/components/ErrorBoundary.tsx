import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureBrowserErrorWithEventId } from "@/observability/sentry";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  eventId: string | null;
}

/**
 * Top-level React ErrorBoundary.
 *
 * Catches render-time errors in the descendant tree, reports them to Sentry
 * (when configured), and renders a recovery UI with a Sentry event ID so the
 * founder has something to reference when contacting support — instead of a
 * white screen with no breadcrumb. P0 from the production-readiness audit.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, eventId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log so dev / non-Sentry deployments still surface the error.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] Render error", error, info);

    // captureBrowserErrorWithEventId is a no-op when Sentry isn't initialized.
    // The dynamic import means the Sentry bundle isn't paid for if VITE_SENTRY_DSN is absent.
    void captureBrowserErrorWithEventId(error, {
      componentStack: info.componentStack,
    }).then((eventId) => {
      if (eventId) {
        this.setState({ eventId });
      }
    });
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null, eventId: null });
  };

  goHome = (): void => {
    window.location.assign("/");
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12 text-center text-foreground"
        >
          <div className="max-w-md space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">
              Something went wrong
            </h1>
            <p className="text-sm text-muted-foreground">
              The page hit an unexpected error. You can try again, or head back
              to the home page. If this keeps happening, please contact support
              with the reference below.
            </p>
            {this.state.eventId && (
              <p className="font-mono text-xs text-muted-foreground">
                Reference: {this.state.eventId}
              </p>
            )}
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={this.reset}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={this.goHome}
                className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Go home
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
