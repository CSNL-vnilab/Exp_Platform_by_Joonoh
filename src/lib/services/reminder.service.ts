import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/google/gmail";
import { sendSMS } from "@/lib/solapi/client";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME, BRAND_CONTACT_EMAIL } from "@/lib/branding";

interface ReminderRow {
  id: string;
  reminder_type: "day_before_evening" | "day_of_morning";
  channel: string;
  bookings: {
    id: string;
    slot_start: string;
    slot_end: string;
    status: string;
    participants: { name: string; phone: string; email: string };
    experiments: { title: string };
  };
}

export async function processReminders(): Promise<number> {
  const supabase = createAdminClient();

  const { data: reminders } = await supabase
    .from("reminders")
    .select(
      "id, reminder_type, channel, bookings(id, slot_start, slot_end, status, participants(name, phone, email), experiments(title))"
    )
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .limit(50);

  if (!reminders || reminders.length === 0) return 0;

  let processed = 0;

  for (const raw of reminders) {
    const reminder = raw as unknown as ReminderRow;
    const booking = reminder.bookings;

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

    try {
      if (reminder.channel === "email" || reminder.channel === "both") {
        const subject = isEvening
          ? `[${BRAND_NAME}] 내일 실험 참여 안내 - ${experiment.title}`
          : `[${BRAND_NAME}] 오늘 실험 참여 안내 - ${experiment.title}`;

        const html = `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>${escapeHtml(subject)}</h2>
            <p>${safeName}님, ${isEvening ? "내일" : "오늘"} 예정된 실험이 있습니다.</p>
            <p><strong>실험명:</strong> ${safeTitle}</p>
            <p><strong>일시:</strong> ${formatDateKR(booking.slot_start)} ${formatTimeKR(booking.slot_start)} - ${formatTimeKR(booking.slot_end)}</p>
            <p>시간에 맞춰 방문 부탁드립니다.</p>
            <p>문의: ${BRAND_CONTACT_EMAIL}</p>
          </div>
        `;

        await sendEmail(participant.email, subject, html);
      }

      if (reminder.channel === "sms" || reminder.channel === "both") {
        const text = isEvening
          ? `[${BRAND_NAME}] 내일 실험 안내\n${participant.name}님, 내일 ${formatTimeKR(booking.slot_start)}에 "${experiment.title}" 실험이 있습니다.\n문의: ${BRAND_CONTACT_EMAIL}`
          : `[${BRAND_NAME}] 오늘 실험 안내\n${participant.name}님, 오늘 ${formatTimeKR(booking.slot_start)}에 "${experiment.title}" 실험이 예정되어 있습니다.\n시간에 맞춰 방문 부탁드립니다.`;

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
