import { createClient } from "@/lib/supabase/server";
import { BookingFlow } from "@/components/booking/booking-flow";

interface BookPageProps {
  params: Promise<{ experimentId: string }>;
}

export default async function BookPage({ params }: BookPageProps) {
  const { experimentId } = await params;

  const supabase = await createClient();
  const { data: experiment, error } = await supabase
    .from("experiments")
    .select("*")
    .eq("id", experimentId)
    .single();

  if (error || !experiment) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
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
        <h1 className="text-xl font-semibold text-foreground">
          실험을 찾을 수 없습니다
        </h1>
        <p className="mt-2 text-sm text-muted">
          링크가 올바른지 확인하거나 담당 연구원에게 문의해주세요.
        </p>
      </div>
    );
  }

  if (experiment.status !== "active") {
    const statusMessages: Record<string, string> = {
      draft: "아직 공개되지 않은 실험입니다.",
      completed: "모집이 완료된 실험입니다.",
      cancelled: "취소된 실험입니다.",
    };

    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-100">
          <svg
            className="h-8 w-8 text-yellow-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-foreground">
          현재 예약을 받지 않습니다
        </h1>
        <p className="mt-2 text-sm text-muted">
          {statusMessages[experiment.status] ?? "예약이 불가능한 상태입니다."}
        </p>
      </div>
    );
  }

  const { data: loc } = experiment.location_id
    ? await supabase
        .from("experiment_locations")
        .select("name, address_lines, naver_url")
        .eq("id", experiment.location_id)
        .maybeSingle()
    : { data: null };

  return <BookingFlow experiment={experiment} location={loc ?? null} />;
}
