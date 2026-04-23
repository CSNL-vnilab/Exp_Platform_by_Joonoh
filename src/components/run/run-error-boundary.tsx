"use client";

import { Component, type ReactNode } from "react";

// Minimal error boundary so a React render crash in the participant shell
// falls back to a Korean message + reload button instead of a blank page.

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RunErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[RunShell] render crash:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl py-20 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
          <svg
            className="h-8 w-8 text-danger"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-foreground">실험 화면에 오류가 발생했습니다</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          페이지를 새로고침해 주세요. 문제가 반복되면 담당 연구원에게 알려주세요.
        </p>
        <button
          type="button"
          onClick={() => {
            if (typeof window !== "undefined") window.location.reload();
          }}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
        >
          새로고침
        </button>
      </div>
    );
  }
}
