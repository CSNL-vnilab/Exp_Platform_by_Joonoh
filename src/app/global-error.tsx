"use client";

// Root global error boundary. Catches render errors thrown ABOVE the route
// segment boundaries (e.g. in the root layout) that would otherwise show a
// blank white screen. Next.js requires this file to render its own <html>/
// <body>. Kept dependency-free (no app CSS is guaranteed to be loaded here)
// with inline styles so it renders even when the root layout is what failed.
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "-apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
          background: "#f8fafc",
          color: "#111827",
          colorScheme: "light",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            width: "100%",
            margin: 16,
            padding: 28,
            borderRadius: 16,
            border: "1px solid #e5e7eb",
            background: "#ffffff",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            textAlign: "center",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            일시적인 오류가 발생했습니다
          </h1>
          <p style={{ margin: "10px 0 0", fontSize: 14, color: "#6b7280" }}>
            잠시 후 다시 시도해 주세요. 문제가 계속되면 담당자에게 문의해 주세요.
          </p>
          {error.digest && (
            <p style={{ margin: "8px 0 0", fontSize: 11, color: "#9ca3af" }}>
              오류 코드: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 20,
              padding: "10px 18px",
              borderRadius: 10,
              border: "none",
              background: "#2563eb",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
