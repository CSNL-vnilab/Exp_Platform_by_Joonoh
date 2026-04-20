"use client";

// Stub — full implementation will be added by another agent.
// This component receives a parsed experiment config and renders a week timetable preview.

interface WeekTimetablePreviewProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
}

export function WeekTimetablePreview({ config }: WeekTimetablePreviewProps) {
  return (
    <div className="rounded-lg border border-border bg-gray-50 p-4">
      <p className="mb-3 text-sm font-medium text-foreground">미리보기 로딩 중...</p>
      <pre className="overflow-auto rounded bg-white p-3 text-xs text-muted border border-border">
        {JSON.stringify(config, null, 2)}
      </pre>
    </div>
  );
}
