import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getGoogleAuth } from "@/lib/google/auth";
import { requireUser } from "@/lib/auth/role";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CalendarEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
}

export async function GET() {
  await requireUser();

  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const { data } = await calendar.calendarList.list({
      maxResults: 250,
      minAccessRole: "writer",
      showDeleted: false,
      showHidden: false,
    });

    const calendars: CalendarEntry[] = (data.items ?? [])
      .filter((c) => c.id)
      .map((c) => ({
        id: c.id!,
        summary: c.summaryOverride || c.summary || c.id!,
        primary: c.primary ?? undefined,
        accessRole: c.accessRole ?? undefined,
        backgroundColor: c.backgroundColor ?? undefined,
      }));

    // Service-account calendarList only returns calendars the account has
    // explicitly been added to. Even when a calendar is shared with the
    // account, it won't appear unless `calendarList.insert` was called. If
    // the project has a GOOGLE_CALENDAR_ID env set and it's not in the list,
    // try fetching it directly — if the service account can read it at all,
    // events.insert will likely succeed, so we surface it in the dropdown.
    const envCalendarId = process.env.GOOGLE_CALENDAR_ID ?? null;
    if (envCalendarId && !calendars.some((c) => c.id === envCalendarId)) {
      try {
        const { data: envCal } = await calendar.calendars.get({ calendarId: envCalendarId });
        calendars.unshift({
          id: envCalendarId,
          summary: envCal.summary || envCalendarId,
          primary: false,
          accessRole: "writer",
        });
      } catch {
        // swallow — fall through with the env id as-is so the dropdown still exposes it
        calendars.unshift({
          id: envCalendarId,
          summary: `${envCalendarId} (직접 연결됨)`,
          primary: false,
          accessRole: "writer",
        });
      }
    }

    calendars.sort((a, b) => (a.primary ? -1 : b.primary ? 1 : a.summary.localeCompare(b.summary)));

    return NextResponse.json({
      calendars,
      defaultId: envCalendarId,
      serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      {
        error: "캘린더 목록을 불러오지 못했습니다",
        detail: message,
        calendars: [],
        serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
      },
      { status: 502 },
    );
  }
}
