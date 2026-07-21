"use client";

import { useState } from "react";

interface Props {
  token: string;
}

export function VerifyForm({ token }: Props) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) {
      setError("이름과 전화번호를 모두 입력해 주세요");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/booking-edit/${token}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "본인 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      // Reload — the server-side page now sees the verify cookie and
      // renders the edit list instead of the gate.
      window.location.reload();
    } catch {
      setError("네트워크 오류로 본인 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
          {error}
        </div>
      )}
      <input
        id="be-name"
        type="text"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        required
        aria-label="이름"
        className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-[15px] focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        placeholder="이름"
      />
      <input
        id="be-phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        disabled={busy}
        required
        aria-label="전화번호"
        className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-[15px] focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        placeholder="전화번호 (010-1234-5678)"
      />
      <button
        type="submit"
        disabled={busy || !name.trim() || !phone.trim()}
        className="w-full rounded-lg bg-blue-600 px-3 py-2.5 text-[15px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "확인 중..." : "확인하고 계속하기"}
      </button>
    </form>
  );
}
