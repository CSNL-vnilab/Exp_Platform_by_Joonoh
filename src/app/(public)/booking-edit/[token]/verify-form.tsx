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
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="be-name" className="block text-xs font-medium text-gray-700">
          이름
        </label>
        <input
          id="be-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          required
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="예약 시 입력한 이름"
        />
      </div>
      <div>
        <label htmlFor="be-phone" className="block text-xs font-medium text-gray-700">
          전화번호
        </label>
        <input
          id="be-phone"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={busy}
          required
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="010-1234-5678"
        />
        <p className="mt-1 text-[11px] text-gray-500">
          하이픈 (-) 유무는 상관없습니다.
        </p>
      </div>
      <button
        type="submit"
        disabled={busy || !name.trim() || !phone.trim()}
        className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "확인 중..." : "본인 확인 및 계속하기"}
      </button>
    </form>
  );
}
