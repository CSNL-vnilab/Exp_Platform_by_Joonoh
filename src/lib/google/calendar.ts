import { google } from "googleapis";
import { getGoogleAuth } from "./auth";

// Google Calendar wrapper with modest retry + clearer error classification.
// Transient failures (429 rate-limit, 500/502/503/504, network hangs) are
// worth one short retry; auth and "not found" errors are not.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 400;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const statusCandidate = (err as { code?: number; status?: number; response?: { status?: number } })?.code
        ?? (err as { status?: number })?.status
        ?? (err as { response?: { status?: number } })?.response?.status;
      const status = typeof statusCandidate === "number" ? statusCandidate : undefined;
      const networky =
        err instanceof Error &&
        /ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up/i.test(err.message);
      const retryable = (status !== undefined && RETRYABLE_STATUS.has(status)) || networky;

      if (!retryable || attempt === MAX_ATTEMPTS) {
        console.error(`[gcal] ${label} failed (attempt ${attempt}):`, err instanceof Error ? err.message : err);
        throw err;
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
    }
  }
  // Unreachable, but TypeScript demands it.
  throw lastError instanceof Error ? lastError : new Error("retry exhausted");
}

export async function getFreeBusy(
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<Array<{ start: Date; end: Date }>> {
  const trimmedId = calendarId.trim();
  return withRetry(`freebusy(${trimmedId})`, async () => {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: trimmedId }],
      },
    });
    const busy = response.data.calendars?.[trimmedId]?.busy || [];
    return busy.map((b) => ({
      start: new Date(b.start!),
      end: new Date(b.end!),
    }));
  });
}

export async function createEvent(
  calendarId: string,
  event: { summary: string; description?: string; start: Date; end: Date },
): Promise<string> {
  return withRetry(`events.insert(${calendarId})`, async () => {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const response = await calendar.events.insert({
      calendarId: calendarId.trim(),
      requestBody: {
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.start.toISOString(), timeZone: "Asia/Seoul" },
        end: { dateTime: event.end.toISOString(), timeZone: "Asia/Seoul" },
      },
    });
    return response.data.id as string;
  });
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  await withRetry(`events.delete(${calendarId})`, async () => {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    try {
      await calendar.events.delete({ calendarId: calendarId.trim(), eventId });
    } catch (err: unknown) {
      // 404/410 are fine — the event is already gone. Swallow to keep
      // reschedule flows idempotent.
      const status = (err as { code?: number; status?: number })?.code
        ?? (err as { status?: number })?.status;
      if (status === 404 || status === 410) return;
      throw err;
    }
  });
}
