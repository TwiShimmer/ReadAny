/**
 * Application/reader error boundary.
 *
 * React only routes render/lifecycle errors here; async failures (PDF parsing,
 * section loading) are handled by the caller and show the same human message.
 * The UI never prints a raw `TypeError` or stack: the user gets a plain
 * explanation plus a deliberate "Copy diagnostics" action for support.
 */
import { copyErrorDiagnostics } from "@/lib/diagnostics";
import i18n from "@readany/core/i18n";
import { AlertTriangle, Copy, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

export type ErrorBoundaryScope = "app" | "reader";

interface ErrorBoundaryProps {
  children: ReactNode;
  scope?: ErrorBoundaryScope;
  /** Reset the boundary when this value changes (e.g. the active reader tab). */
  resetKey?: string;
  /** Extra context for diagnostics; must not contain file paths or secrets. */
  context?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  copyState: "idle" | "copied" | "failed";
}

/** Distinct errors seen this session; keeps logging bounded. */
const errorCounts = new Map<string, number>();
const MAX_TRACKED_ERRORS = 50;

function errorSignature(error: Error): string {
  return `${error.name}:${error.message}`.slice(0, 200);
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Unknown error");
}

/** Logs the full stack once per distinct error, then counts repetitions. */
export function logCaughtError(error: Error, info?: ErrorInfo): void {
  const signature = errorSignature(error);
  const count = (errorCounts.get(signature) ?? 0) + 1;

  if (errorCounts.size >= MAX_TRACKED_ERRORS && !errorCounts.has(signature)) {
    errorCounts.clear();
  }
  errorCounts.set(signature, count);

  if (count === 1) {
    console.error("[ErrorBoundary] Uncaught error:", error, info?.componentStack ?? "");
    return;
  }

  console.warn(`[ErrorBoundary] Repeated error x${count}: ${signature}`);
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, copyState: "idle" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: normalizeError(error), copyState: "idle" };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logCaughtError(error, info);
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  private reset = (): void => {
    this.setState({ error: null, copyState: "idle" });
  };

  private copyDiagnostics = async (): Promise<void> => {
    const { scope = "app", context } = this.props;
    if (!this.state.error) return;

    try {
      await copyErrorDiagnostics(this.state.error, { scope, context });
      this.setState({ copyState: "copied" });
    } catch (copyError) {
      console.error("[ErrorBoundary] Failed to copy diagnostics:", copyError);
      this.setState({ copyState: "failed" });
    }
  };

  render(): ReactNode {
    const { error, copyState } = this.state;
    if (!error) return this.props.children;

    const isReader = this.props.scope === "reader";
    const title = i18n.t(
      isReader ? "reader.errorBoundary.title" : "reader.errorBoundary.appTitle",
      {
        defaultValue: isReader ? "This page ran into a problem" : "ReadAny ran into a problem",
      },
    );
    const description = i18n.t(
      isReader ? "reader.errorBoundary.description" : "reader.errorBoundary.appDescription",
      {
        defaultValue: isReader
          ? "The book could not be displayed. Your reading progress and notes are safe."
          : "The interface could not be displayed. Your library and notes are safe.",
      },
    );
    const copyLabel = i18n.t("reader.errorBoundary.copyDiagnostics", {
      defaultValue: "Copy diagnostics",
    });

    return (
      <div className="flex h-full min-h-[240px] w-full items-center justify-center bg-background p-8">
        <div className="flex max-w-md flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            >
              <RotateCcw className="h-4 w-4" />
              {i18n.t("common.retry", { defaultValue: "Retry" })}
            </button>
            <button
              type="button"
              onClick={() => void this.copyDiagnostics()}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm text-foreground hover:bg-muted"
            >
              <Copy className="h-4 w-4" />
              {copyLabel}
            </button>
          </div>

          {copyState !== "idle" && (
            <p
              className={`mt-3 text-xs ${
                copyState === "copied" ? "text-muted-foreground" : "text-destructive"
              }`}
            >
              {copyState === "copied"
                ? i18n.t("reader.errorBoundary.copied", { defaultValue: "Diagnostics copied" })
                : i18n.t("reader.errorBoundary.copyFailed", {
                    defaultValue: "Could not copy diagnostics",
                  })}
            </p>
          )}
        </div>
      </div>
    );
  }
}

/** Application-wide boundary mounted around the entire React tree. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary scope="app">{children}</ErrorBoundary>;
}
