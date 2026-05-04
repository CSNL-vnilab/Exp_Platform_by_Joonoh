import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken, bytesFromSupabase } from "@/lib/crypto/payment-info";
import { buildPaymentInfoEmail } from "@/lib/services/payment-info-email-template";
import { CopyButton } from "./copy-button";

export const dynamic = "force-dynamic";

// Researcher-side preview of the participant-facing 정산 정보 입력 안내
// email + the form URL the participant lands on. Reuses the SAME token
// already stored in DB (decrypts the cipher; never re-issues), so the
// preview cannot leak a fresh extended-expiry token. No SMTP call —
// purely server-render of the email HTML inside a sandboxed iframe.

export default async function PaymentInfoPreviewPage({
  params,
}: {
  params: Promise<{ experimentId: string; bookingGroupId: string }>;
}) {
  const { experimentId, bookingGroupId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const admin = createAdminClient();

  const { data: exp } = await admin
    .from("experiments")
    .select("id, title, created_by")
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) notFound();

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id) notFound();

  const { data: rowRaw } = await admin
    .from("participant_payment_info")
    .select(
      "id, participant_id, amount_krw, period_start, period_end, name_override, email_override, " +
        "token_cipher, token_iv, token_tag, token_key_version, token_expires_at, " +
        "payment_link_sent_at, payment_link_first_opened_at, status",
    )
    .eq("experiment_id", experimentId)
    .eq("booking_group_id", bookingGroupId)
    .maybeSingle();
  const row = rowRaw as unknown as
    | {
        id: string;
        participant_id: string;
        amount_krw: number;
        period_start: string | null;
        period_end: string | null;
        name_override: string | null;
        email_override: string | null;
        token_cipher: unknown;
        token_iv: unknown;
        token_tag: unknown;
        token_key_version: number | null;
        token_expires_at: string | null;
        payment_link_sent_at: string | null;
        payment_link_first_opened_at: string | null;
        status: string;
      }
    | null;
  if (!row) notFound();

  const [{ data: participant }, { data: researcherProfile }] = await Promise.all([
    admin
      .from("participants")
      .select("name, email")
      .eq("id", row.participant_id)
      .maybeSingle(),
    exp.created_by
      ? admin
          .from("profiles")
          .select("display_name, contact_email, phone")
          .eq("id", exp.created_by)
          .maybeSingle()
      : Promise.resolve({ data: null } as { data: null }),
  ]);

  const recipientName =
    (row.name_override?.trim() || participant?.name || "참여자").trim();
  const recipientEmail =
    (row.email_override?.trim() || participant?.email || "").trim();

  // Token: decrypt from cipher rather than re-issuing. If cipher missing
  // (legacy row pre-00052) we still render the email HTML but flag the
  // URL as unavailable so the researcher knows the actual dispatch will
  // mint a fresh one.
  const cipher = bytesFromSupabase(row.token_cipher);
  const iv = bytesFromSupabase(row.token_iv);
  const tag = bytesFromSupabase(row.token_tag);
  const haveCipher =
    cipher.length > 0 && iv.length > 0 && tag.length > 0 && row.token_key_version != null;

  let tokenString: string | null = null;
  let tokenError: string | null = null;
  if (haveCipher) {
    try {
      tokenString = decryptToken({
        cipher,
        iv,
        tag,
        keyVersion: row.token_key_version!,
      });
    } catch (e) {
      tokenError = e instanceof Error ? e.message : String(e);
    }
  } else {
    tokenError = "암호화된 토큰이 DB에 없습니다 (legacy 행). 실제 발송 시 새 토큰이 발급됩니다.";
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}`.replace(/\/$/, "") : "");
  const paymentUrl = tokenString
    ? `${origin}/payment-info/${encodeURIComponent(tokenString)}`
    : `${origin}/payment-info/PREVIEW_TOKEN_PLACEHOLDER`;

  const tokenExpiresAtIso =
    row.token_expires_at ?? new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();

  const built = buildPaymentInfoEmail({
    participantName: recipientName,
    participantEmail: recipientEmail || "(미설정)",
    experimentTitle: exp.title,
    amountKrw: row.amount_krw,
    paymentUrl,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    researcher: researcherProfile
      ? {
          displayName:
            (researcherProfile as { display_name: string | null }).display_name,
          contactEmail:
            (researcherProfile as { contact_email: string | null }).contact_email,
          phone: (researcherProfile as { phone: string | null }).phone,
        }
      : null,
    tokenExpiresAt: tokenExpiresAtIso,
    isReminder: row.payment_link_sent_at != null,
  });

  const expiryDisplay = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(tokenExpiresAtIso));

  return (
    <div className="space-y-4">
      <div
        className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        role="status"
      >
        <strong>미리보기 모드</strong> — 이 페이지는 참여자에게 발송될 메일과 폼을 그대로
        보여주지만 메일은 발송되지 않습니다. 토큰은 DB에 이미 저장된 것을 그대로 재사용하므로
        만료 시각이 바뀌지 않습니다.
        <Link
          href={`/experiments/${experimentId}`}
          className="ml-2 underline hover:text-amber-700"
        >
          돌아가기
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-xl border border-border bg-white">
          <div className="border-b border-border bg-muted/20 px-4 py-2 text-xs text-muted">
            <div>
              <span className="font-medium text-foreground">받는 사람:</span>{" "}
              {recipientName} &lt;{recipientEmail || "(이메일 없음)"}&gt;
            </div>
            <div className="mt-0.5">
              <span className="font-medium text-foreground">제목:</span>{" "}
              {built.subject}
            </div>
          </div>
          <iframe
            title="email-preview"
            srcDoc={built.html}
            sandbox=""
            className="block h-[720px] w-full border-0"
          />
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-white p-4 text-sm">
            <h3 className="text-sm font-semibold text-foreground">참여자 폼 링크</h3>
            <p className="mt-1 text-xs text-muted">
              메일의 <q>정산 정보 입력하기</q> 버튼이 연결되는 URL입니다.
            </p>
            {tokenError ? (
              <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {tokenError}
              </p>
            ) : (
              <>
                <div className="mt-3 break-all rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px] font-mono text-foreground">
                  {paymentUrl}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={paymentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                  >
                    🔗 새 탭에서 폼 열기
                  </a>
                  <CopyButton text={paymentUrl} />
                </div>
                <p className="mt-3 text-[11px] text-muted">
                  열림 기록(<code>first_opened_at</code>)은 폼을 처음 GET 할 때 갱신됩니다.
                  미리보기에서 열어보면 실제 참여자가 열기 전에 카운터가 올라가니
                  주의해 주세요.
                </p>
              </>
            )}
          </div>

          <div className="rounded-xl border border-border bg-white p-4 text-sm space-y-2">
            <h3 className="text-sm font-semibold text-foreground">메타</h3>
            <Meta label="실험" value={exp.title} />
            <Meta label="지급액" value={`${row.amount_krw.toLocaleString()}원`} />
            <Meta
              label="기간"
              value={
                row.period_start && row.period_end
                  ? `${row.period_start} ~ ${row.period_end}`
                  : row.period_start ?? "-"
              }
            />
            <Meta label="만료" value={expiryDisplay} />
            <Meta
              label="이전 발송"
              value={
                row.payment_link_sent_at
                  ? new Date(row.payment_link_sent_at).toLocaleString("ko-KR")
                  : "(미발송)"
              }
            />
            <Meta
              label="첫 열람"
              value={
                row.payment_link_first_opened_at
                  ? new Date(row.payment_link_first_opened_at).toLocaleString("ko-KR")
                  : "(없음)"
              }
            />
            <Meta label="상태" value={row.status} />
            {row.payment_link_sent_at && (
              <p className="mt-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-900">
                이 행은 이미 한 번 발송된 적이 있어 메일 본문이
                <em>(재안내)</em> 모드로 렌더링됩니다.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 pb-1 last:border-b-0">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-right text-xs font-medium text-foreground">{value}</span>
    </div>
  );
}
