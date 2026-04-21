import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryLabel, locationInfo } from "@/lib/experiments/categories";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { fromInternalEmail } from "@/lib/auth/username";

type LocationRow = { name: string; address_lines: string[]; naver_url: string | null };

interface PageProps {
  params: Promise<{ experimentId: string }>;
  searchParams: Promise<{ bookingGroupId?: string }>;
}

const uuidRe = /^[0-9a-f-]{36}$/i;

export default async function ConfirmPage({ params, searchParams }: PageProps) {
  const { experimentId } = await params;
  const { bookingGroupId } = await searchParams;

  if (!uuidRe.test(experimentId)) notFound();

  const supabase = createAdminClient();
  const { data: experiment } = await supabase
    .from("experiments")
    .select("*")
    .eq("id", experimentId)
    .single();
  if (!experiment) notFound();

  let bookings: Array<{ slot_start: string; slot_end: string; session_number: number }> = [];
  if (bookingGroupId && uuidRe.test(bookingGroupId)) {
    const { data } = await supabase
      .from("bookings")
      .select("slot_start, slot_end, session_number")
      .eq("booking_group_id", bookingGroupId)
      .eq("experiment_id", experimentId)
      .order("session_number", { ascending: true });
    bookings = data ?? [];
  }

  // Resolve location: prefer new location_id, fall back to legacy location string
  let loc: LocationRow | null = null;
  if (experiment.location_id) {
    const { data: locRow } = await supabase
      .from("experiment_locations")
      .select("name, address_lines, naver_url")
      .eq("id", experiment.location_id)
      .maybeSingle();
    loc = locRow ?? null;
  } else if (experiment.location) {
    const legacy = locationInfo(experiment.location);
    if (legacy) {
      loc = {
        name: legacy.shortName,
        address_lines: legacy.addressLines,
        naver_url: legacy.naverMapUrl,
      };
    }
  }

  const { data: researcher } = experiment.created_by
    ? await supabase
        .from("profiles")
        .select("display_name, email, phone, contact_email")
        .eq("id", experiment.created_by)
        .maybeSingle()
    : { data: null };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-500 text-white">
          <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-green-800">예약이 확정되었습니다</h1>
        <p className="mt-1 text-sm text-green-700">
          입력하신 이메일과 휴대전화로 확정 안내가 발송됩니다.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-white p-5">
        <h2 className="mb-3 text-base font-semibold text-foreground">{experiment.title}</h2>
        {experiment.categories && experiment.categories.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {experiment.categories.map((c) => (
              <span key={c} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                #{categoryLabel(c)}
              </span>
            ))}
          </div>
        )}
        {bookings.length > 0 && (
          <ul className="space-y-1 text-sm text-foreground">
            {bookings.map((b, i) => (
              <li key={i}>
                <span className="font-medium">{b.session_number}회차</span>{" "}
                <span className="text-muted">—</span>{" "}
                {formatDateKR(b.slot_start)} {formatTimeKR(b.slot_start)} - {formatTimeKR(b.slot_end)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {loc && (
        <div className="rounded-xl border border-border bg-white p-5">
          <h2 className="mb-3 text-base font-semibold text-foreground">📍 찾아오시는 길</h2>
          <div className="mb-3">
            <div className="text-sm font-semibold text-foreground">{loc.name}</div>
            {loc.address_lines.map((line, i) => (
              <div key={i} className="text-sm text-muted">
                {line}
              </div>
            ))}
          </div>
          {loc.naver_url && (
            <>
              <a
                href={loc.naver_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#03C75A] px-4 py-2 text-sm font-medium text-white hover:bg-[#02A64C]"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M16.273 12.845 7.376 0H0v24h7.726V11.156L16.624 24H24V0h-7.727v12.845Z" />
                </svg>
                네이버 지도에서 열기
              </a>
              <p className="mt-2 text-xs text-muted">
                {loc.naver_url}
              </p>
            </>
          )}
        </div>
      )}

      {researcher && (
        <div className="rounded-xl border border-border bg-white p-5">
          <h2 className="mb-3 text-base font-semibold text-foreground">📞 문의</h2>
          <div className="space-y-1 text-sm">
            <div>
              <span className="text-muted">담당자:</span>{" "}
              <span className="font-medium text-foreground">
                {researcher.display_name ?? "-"}
              </span>
              {researcher.phone && (
                <span className="ml-1 text-muted">({researcher.phone})</span>
              )}
            </div>
            <div>
              <span className="text-muted">이메일:</span>{" "}
              <span className="text-foreground">
                {researcher.contact_email ||
                  fromInternalEmail(researcher.email) ||
                  researcher.email ||
                  "(이메일 정보 없음)"}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="text-center">
        <Link href="/" className="text-sm text-muted hover:text-foreground">
          홈으로
        </Link>
      </div>
    </div>
  );
}
