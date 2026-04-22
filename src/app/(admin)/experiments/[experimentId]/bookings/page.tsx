import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { BookingsManager, type BookingRowView } from "@/components/bookings-manager";

export const dynamic = "force-dynamic";

export default async function BookingsPage({
  params,
}: {
  params: Promise<{ experimentId: string }>;
}) {
  const { experimentId } = await params;
  const supabase = await createClient();

  const { data: experiment } = await supabase
    .from("experiments")
    .select("id, title, session_type, required_sessions, project_name")
    .eq("id", experimentId)
    .single();

  if (!experiment) {
    notFound();
  }

  const { data: bookings } = await supabase
    .from("bookings")
    .select(
      `id, slot_start, slot_end, session_number, status, created_at, subject_number,
       participants (name, phone, email, gender, birthdate)`,
    )
    .eq("experiment_id", experimentId)
    .order("slot_start", { ascending: true });

  const rows: BookingRowView[] = ((bookings ?? []) as unknown as BookingRowView[]) ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href={`/experiments/${experimentId}`}
            className="text-sm text-muted hover:text-foreground"
          >
            &larr; 실험 상세로 돌아가기
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-foreground">
            예약 관리 · {experiment.title}
          </h1>
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted">아직 예약이 없습니다.</p>
          </CardContent>
        </Card>
      ) : (
        <BookingsManager
          experimentId={experimentId}
          experimentTitle={experiment.title}
          projectName={experiment.project_name ?? null}
          rows={rows}
        />
      )}
    </div>
  );
}
