import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookingActions } from "@/components/booking-actions";
import { format } from "date-fns";

const bookingStatusConfig: Record<
  string,
  { label: string; variant: "default" | "success" | "danger" | "info" | "warning" }
> = {
  confirmed: { label: "확정", variant: "success" },
  cancelled: { label: "취소", variant: "danger" },
  completed: { label: "완료", variant: "info" },
  no_show: { label: "노쇼", variant: "warning" },
};

export default async function BookingsPage({
  params,
}: {
  params: Promise<{ experimentId: string }>;
}) {
  const { experimentId } = await params;
  const supabase = await createClient();

  const { data: experiment } = await supabase
    .from("experiments")
    .select("id, title")
    .eq("id", experimentId)
    .single();

  if (!experiment) {
    notFound();
  }

  const { data: bookings } = await supabase
    .from("bookings")
    .select(`
      id,
      slot_start,
      slot_end,
      session_number,
      status,
      created_at,
      participant_id,
      participants (
        name,
        phone,
        email
      )
    `)
    .eq("experiment_id", experimentId)
    .order("slot_start", { ascending: true });

  return (
    <div>
      <div className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href={`/experiments/${experimentId}`}
            className="text-sm text-muted hover:text-foreground"
          >
            &larr; 실험 상세로 돌아가기
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-foreground">
            예약 관리 - {experiment.title}
          </h1>
        </div>
      </div>

      {!bookings || bookings.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted">예약이 없습니다.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left font-medium text-muted">참여자</th>
                    <th className="px-4 py-3 text-left font-medium text-muted">연락처</th>
                    <th className="px-4 py-3 text-left font-medium text-muted">예약 시간</th>
                    <th className="px-4 py-3 text-left font-medium text-muted">상태</th>
                    <th className="px-4 py-3 text-left font-medium text-muted">예약일</th>
                    <th className="px-4 py-3 text-left font-medium text-muted">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((booking) => {
                    // participants comes back as a joined object (single row)
                    const participant = booking.participants as unknown as {
                      name: string;
                      phone: string;
                      email: string;
                    } | null;
                    const statusInfo =
                      bookingStatusConfig[booking.status] ?? bookingStatusConfig.confirmed;

                    return (
                      <tr
                        key={booking.id}
                        className="border-b border-border last:border-b-0 hover:bg-card/50"
                      >
                        <td className="px-4 py-3 font-medium text-foreground">
                          {participant?.name ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          <div>{participant?.phone ?? "-"}</div>
                          <div className="text-xs">{participant?.email ?? ""}</div>
                        </td>
                        <td className="px-4 py-3 text-foreground whitespace-nowrap">
                          {format(new Date(booking.slot_start), "MM.dd HH:mm")} ~{" "}
                          {format(new Date(booking.slot_end), "HH:mm")}
                          {booking.session_number > 1 && (
                            <span className="ml-1 text-xs text-muted">
                              ({booking.session_number}회차)
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted whitespace-nowrap">
                          {format(new Date(booking.created_at), "yyyy.MM.dd")}
                        </td>
                        <td className="px-4 py-3">
                          {booking.status === "confirmed" && (
                            <BookingActions
                              bookingId={booking.id}
                              experimentId={experimentId}
                              currentSlotStart={booking.slot_start}
                              currentSlotEnd={booking.slot_end}
                              sessionNumber={booking.session_number}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
