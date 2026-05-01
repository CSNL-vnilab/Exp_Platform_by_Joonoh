import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/google/gmail";
import { sendSMS } from "@/lib/solapi/client";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";

interface ReminderRow {
  id: string;
  reminder_type: "day_before_evening" | "day_of_morning";
  channel: string;
  bookings: {
    id: string;
    slot_start: string;
    slot_end: string;
    status: string;
    session_number: number;
    participants: { name: string; phone: string; email: string };
    experiments: {
      title: string;
      created_by: string | null;
      precautions: Array<{ question: string; required_answer: boolean }> | null;
      location_id: string | null;
    };
  };
}

interface CreatorInfo {
  contact_email: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
}

interface LocationInfo {
  name: string;
  address_lines: string[];
  naver_url: string | null;
}

export async function processReminders(): Promise<number> {
  const supabase = createAdminClient();

  const { data: reminders } = await supabase
    .from("reminders")
    .select(
      "id, reminder_type, channel, bookings(id, slot_start, slot_end, status, session_number, participants(name, phone, email), experiments(title, created_by, precautions, location_id))",
    )
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .limit(50);

  if (!reminders || reminders.length === 0) return 0;

  let processed = 0;

  // Resolve researcher contact once per created_by to avoid N+1 profile fetches.
  const creatorCache = new Map<string, CreatorInfo>();
  async function getCreator(userId: string | null): Promise<CreatorInfo | null> {
    if (!userId) return null;
    if (!creatorCache.has(userId)) {
      const { data } = await supabase
        .from("profiles")
        .select("contact_email, display_name, phone, email")
        .eq("id", userId)
        .maybeSingle();
      creatorCache.set(userId, {
        contact_email: (data?.contact_email ?? "").trim() || null,
        display_name: (data?.display_name ?? "").trim() || null,
        phone: (data?.phone ?? "").trim() || null,
        email: (data?.email ?? "").trim() || null,
      });
    }
    return creatorCache.get(userId) ?? null;
  }

  // Resolve location once per id.
  const locCache = new Map<string, LocationInfo | null>();
  async function getLocation(locId: string | null): Promise<LocationInfo | null> {
    if (!locId) return null;
    if (!locCache.has(locId)) {
      const { data } = await supabase
        .from("experiment_locations")
        .select("name, address_lines, naver_url")
        .eq("id", locId)
        .maybeSingle();
      locCache.set(locId, (data as LocationInfo | null) ?? null);
    }
    return locCache.get(locId) ?? null;
  }

  for (const raw of reminders) {
    const reminder = raw as unknown as ReminderRow;
    const booking = reminder.bookings;

    // Booking got cancelled after the reminder was scheduled → skip and close out.
    if (booking.status === "cancelled") {
      await supabase
        .from("reminders")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", reminder.id);
      continue;
    }

    const participant = booking.participants;
    const experiment = booking.experiments;
    const isEvening = reminder.reminder_type === "day_before_evening";

    const safeName = escapeHtml(participant.name);
    const safeTitle = escapeHtml(experiment.title);

    const creator = await getCreator(experiment.created_by);
    // Prefer public contact_email; fall back to login email so something always shows.
    const researcherEmail =
      (creator?.contact_email || creator?.email || "").trim() || null;
    const researcherName = creator?.display_name || "담당 연구원";
    const researcherPhone = creator?.phone || "";
    // Researcher's contact wins. If they've never set one, fall back to
    // the lab-wide inbox — but only if the deploy actually configured it
    // (otherwise we'd render a placeholder address). When neither exists,
    // template / SMS branches conditionally hide the "문의" line entirely.
    const contactLine = researcherEmail || brandContactEmailOrNull();

    const location = await getLocation(experiment.location_id);

    try {
      if (reminder.channel === "email" || reminder.channel === "both") {
        const headline = isEvening
          ? `내일 실험 일정 안내드립니다`
          : `오늘 실험에 참여해 주셔서 감사합니다`;
        const subject = isEvening
          ? `[${BRAND_NAME}] 내일 실험 리마인드 — ${experiment.title}`
          : `[${BRAND_NAME}] 오늘 실험 리마인드 — ${experiment.title}`;

        const whenLine = `${formatDateKR(booking.slot_start)} ${formatTimeKR(booking.slot_start)} – ${formatTimeKR(booking.slot_end)}`;
        const sessionSuffix =
          booking.session_number > 1 ? ` · ${booking.session_number}회차` : "";

        const precautionsBlock =
          experiment.precautions && experiment.precautions.length > 0
            ? `
            <div style="margin:18px 0;padding:14px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;">
              <p style="margin:0 0 8px 0;font-weight:600;color:#92400e;">참여 전 확인 사항</p>
              <ul style="margin:0;padding-left:18px;color:#78350f;">
                ${experiment.precautions
                  .map((p) => `<li style="margin:3px 0;">${escapeHtml(p.question)}</li>`)
                  .join("")}
              </ul>
              <p style="margin:10px 0 0 0;font-size:12px;color:#92400e;">
                위 항목 중 하나라도 변경되었다면 실험 전에 담당 연구원에게 알려주세요.
              </p>
            </div>`
            : "";

        const locationBlock = location
          ? `
            <p style="margin:18px 0 6px 0;font-weight:600;">찾아오시는 길</p>
            <p style="margin:0;line-height:1.55;">
              ${escapeHtml(location.name)}<br/>
              ${location.address_lines.map((l) => escapeHtml(l)).join("<br/>")}
            </p>
            ${
              location.naver_url
                ? `<p style="margin:8px 0 0 0;"><a href="${location.naver_url}" style="color:#2563eb;">네이버 지도에서 열기 →</a></p>`
                : ""
            }`
          : "";

        // Hide the email line if neither researcher contact_email nor a
        // configured lab-wide inbox is available — leaving an empty
        // mailto: would still render as a clickable but useless link.
        const contactEmailLine = contactLine
          ? `<a href="mailto:${contactLine}" style="color:#2563eb;">${escapeHtml(contactLine)}</a>`
          : "";
        const contactBlock = `
          <p style="margin:20px 0 6px 0;font-weight:600;">담당 연구원 · 문의</p>
          <p style="margin:0;line-height:1.6;">
            ${escapeHtml(researcherName)}${
              researcherPhone ? ` · ${escapeHtml(researcherPhone)}` : ""
            }${contactEmailLine ? `<br/>${contactEmailLine}` : ""}
          </p>`;

        const html = `
          <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.55;">
            <div style="padding:14px 18px;background:${isEvening ? "#eff6ff" : "#fef3c7"};border:1px solid ${isEvening ? "#93c5fd" : "#fcd34d"};border-radius:10px;margin-bottom:18px;">
              <p style="margin:0;font-size:15px;font-weight:600;color:${isEvening ? "#1e40af" : "#92400e"};">${
                isEvening ? "🔔" : "⏰"
              } ${headline}</p>
            </div>
            <p style="margin:0 0 6px 0;">${safeName}님, 안녕하세요.</p>
            <p style="margin:0 0 14px 0;">
              ${
                isEvening
                  ? `내일 예정된 <b>${safeTitle}</b> 실험을 잊지 않으시도록 안내드립니다.`
                  : `오늘 <b>${safeTitle}</b> 실험에 참여해 주시는 날입니다. 시간 맞춰 오실 수 있도록 조금 더 미리 알려드립니다.`
              }
            </p>

            <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;">
              <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:110px;">실험명</td><td style="padding:10px 12px;border:1px solid #e5e7eb;">${safeTitle}</td></tr>
              <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">일시</td><td style="padding:10px 12px;border:1px solid #e5e7eb;">${escapeHtml(whenLine)}${sessionSuffix}</td></tr>
            </table>

            ${locationBlock}
            ${precautionsBlock}
            ${contactBlock}

            <p style="margin:22px 0 6px 0;font-size:13px;color:#6b7280;">
              ${
                isEvening
                  ? "실험 시작 10분 전까지 도착해 주시면 감사하겠습니다. 부득이하게 불참하시는 경우에도 담당자에게 미리 연락 부탁드립니다."
                  : "실험장소 도착 후 담당 연구원에게 간단히 인사 부탁드립니다. 조심히 오세요!"
              }
            </p>
            <p style="margin:4px 0 0 0;font-size:12px;color:#9ca3af;">
              ${BRAND_NAME} — 자동 발송된 리마인드 메일입니다.
            </p>
          </div>
        `;

        await sendEmail({
          to: participant.email,
          cc:
            researcherEmail && researcherEmail !== participant.email
              ? researcherEmail
              : undefined,
          subject,
          html,
        });
      }

      if (reminder.channel === "sms" || reminder.channel === "both") {
        // Skip the "문의:" line if no real contact is available — see
        // the email-template comment above for rationale.
        const inquirySuffix = contactLine ? `\n문의: ${contactLine}` : "";
        const text = isEvening
          ? `[${BRAND_NAME}] 내일 실험 안내\n${participant.name}님, 내일 ${formatTimeKR(booking.slot_start)} "${experiment.title}" 실험이 있습니다.${inquirySuffix}`
          : `[${BRAND_NAME}] 오늘 실험 안내\n${participant.name}님, 오늘 ${formatTimeKR(booking.slot_start)} "${experiment.title}" 실험이 예정되어 있습니다.${inquirySuffix}`;
        await sendSMS(participant.phone, text);
      }

      await supabase
        .from("reminders")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", reminder.id);

      processed++;
    } catch (err) {
      console.error(`[Reminder] Failed for reminder ${reminder.id}:`, err);
      await supabase
        .from("reminders")
        .update({ status: "failed" })
        .eq("id", reminder.id);
    }
  }

  return processed;
}
