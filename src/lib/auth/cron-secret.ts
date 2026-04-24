import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

const MIN_SECRET_LENGTH = 32;

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

function safeEqualHashed(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

export function authorizeCronRequest(request: NextRequest): boolean {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;

  const custom = request.headers.get("x-cron-secret") ?? "";
  if (custom && safeEqualHashed(custom, expected)) return true;

  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && safeEqualHashed(token, expected)) return true;
  }

  return false;
}
