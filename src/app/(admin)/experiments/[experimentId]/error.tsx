"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function ExperimentDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ExperimentDetail] error:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl py-12">
      <h1 className="text-xl font-bold text-foreground">페이지 로딩 중 오류가 발생했습니다</h1>
      <p className="mt-2 text-sm text-muted">{error.message || "알 수 없는 오류"}</p>
      {error.digest && (
        <p className="mt-1 text-xs text-muted">digest: {error.digest}</p>
      )}
      <pre className="mt-4 max-h-80 overflow-auto rounded-lg border border-border bg-gray-50 p-3 text-xs text-foreground">
        {error.stack ?? ""}
      </pre>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          다시 시도
        </button>
        <Link
          href="/experiments"
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-card"
        >
          실험 목록으로
        </Link>
      </div>
    </div>
  );
}
