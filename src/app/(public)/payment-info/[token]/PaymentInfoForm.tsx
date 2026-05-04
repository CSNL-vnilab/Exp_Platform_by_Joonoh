"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";

// "" sentinel forces the participant to pick a bank explicitly. We never
// pre-fill 은행명 — that's a per-participant-policy rule (no leakage of
// the other participant's bank into the dropdown via wrong default).
const BANK_PLACEHOLDER = "";
const BANKS = [
  "국민은행", "기업은행", "신한은행", "우리은행", "하나은행",
  "농협은행", "SC제일은행", "씨티은행", "카카오뱅크", "토스뱅크",
  "케이뱅크", "부산은행", "대구은행", "경남은행", "광주은행",
  "전북은행", "제주은행", "산업은행", "수협은행",
  "새마을금고", "신협", "우체국", "저축은행", "기타",
];

const BANKBOOK_MAX_BYTES = 5 * 1024 * 1024;
const BANKBOOK_TYPES = ["image/png", "image/jpeg", "application/pdf"];

interface Props {
  token: string;
  // Only contact-channel pre-fill is permitted (email + phone). Name,
  // bank, account, RRN, holder, institution must always start empty so
  // participants explicitly enter what's theirs — both for accuracy
  // (avoid a wrong cached value silently propagating) and for the
  // privacy invariant "the form must never display anyone else's
  // sensitive data, including their own name leaking from a stale
  // participants row".
  defaultPhone: string;
  defaultEmail: string;
  experimentTitle: string;
  amountKrw: number;
}

export default function PaymentInfoForm({
  token,
  defaultPhone,
  defaultEmail,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState(defaultPhone);
  const [email, setEmail] = useState(defaultEmail);
  const [rrn, setRrn] = useState("");
  const [bank, setBank] = useState(BANK_PLACEHOLDER);
  const [account, setAccount] = useState("");
  const [holder, setHolder] = useState("");
  const [institution, setInstitution] = useState("");
  // Submit stage so the long upload doesn't look frozen. fetch() doesn't
  // expose upload progress, so we approximate with discrete labels.
  const [submitStage, setSubmitStage] =
    useState<"idle" | "encoding" | "sending">("idle");
  const submitting = submitStage !== "idle";
  // RRN visibility toggle. 뒷자리 7자리는 어깨너머 노출 우려가 있어 기본
  // 으로 가린다. 사용자가 직접 보고 싶으면 토글 버튼으로 표시.
  const [rrnVisible, setRrnVisible] = useState(false);
  // Inline submit error block — replaces toast for failure cases so the
  // recovery guide stays on screen until the user dismisses it (P0-C-P1-7).
  const [submitError, setSubmitError] = useState<{
    title: string;
    detail: string;
    showRecoverySteps: boolean;
  } | null>(null);

  const [bankbook, setBankbook] = useState<File | null>(null);
  const [bankbookPreview, setBankbookPreview] = useState<string | null>(null);
  const bankbookInputRef = useRef<HTMLInputElement | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasSignedRef = useRef(false);
  const [hasSigned, setHasSigned] = useState(false);

  const handleRrnChange = useCallback((raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 13);
    if (digits.length <= 6) {
      setRrn(digits);
    } else {
      setRrn(`${digits.slice(0, 6)}-${digits.slice(6)}`);
    }
  }, []);

  // Auto-format Korean mobile/landline as user types: 010-1234-5678,
  // 02-123-4567, 031-234-5678. Server still trims/validates loosely so
  // foreign numbers or formats we don't recognize won't be rejected.
  const handlePhoneChange = useCallback((raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 11);
    if (digits.length < 4) {
      setPhone(digits);
      return;
    }
    if (digits.startsWith("02")) {
      // Seoul landline: 2-3/4-4 split.
      if (digits.length <= 5) {
        setPhone(`${digits.slice(0, 2)}-${digits.slice(2)}`);
      } else if (digits.length <= 9) {
        setPhone(`${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`);
      } else {
        setPhone(`${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`);
      }
      return;
    }
    // 010 / 011 / 031 / etc.
    if (digits.length <= 7) {
      setPhone(`${digits.slice(0, 3)}-${digits.slice(3)}`);
    } else if (digits.length <= 10) {
      setPhone(`${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`);
    } else {
      setPhone(`${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`);
    }
  }, []);

  // Canvas: retina-scale + fill white bg so toDataURL is a proper PNG.
  // Re-init on viewport resize / orientation change so the canvas
  // doesn't end up with stale DPR-scaled dimensions when the participant
  // rotates their phone mid-signature (C-P1-5). Existing strokes are
  // wiped — better than rendering them at the wrong scale and confusing
  // the user; we surface this in the help text below the canvas.
  useEffect(() => {
    function initCanvas() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      // Reset transform first, then re-scale, so re-init from a resize
      // doesn't compound dpr scaling.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#111111";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      hasSignedRef.current = false;
      setHasSigned(false);
    }
    initCanvas();
    window.addEventListener("resize", initCanvas);
    window.addEventListener("orientationchange", initCanvas);
    return () => {
      window.removeEventListener("resize", initCanvas);
      window.removeEventListener("orientationchange", initCanvas);
    };
  }, []);

  // P0-Ε: stamp payment_link_first_opened_at via /touch — only fires
  // because a real browser actually mounted this client component, so
  // bots / link-previewers / spam-filter scrapers (which don't execute
  // JS) can't trip the stamp. The flag controls token-preserve behavior
  // in payment-info-notify.service; tripping it inappropriately would
  // pin the token alive for the 60-day TTL.
  useEffect(() => {
    // fire-and-forget; idempotent on the server. No state change here.
    fetch(`/api/payment-info/${encodeURIComponent(token)}/touch`, {
      method: "POST",
    }).catch(() => {
      // Network failure is fine — the next visit will try again.
    });
  }, [token]);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasSignedRef.current) {
      hasSignedRef.current = true;
      setHasSigned(true);
    }
  };

  const onPointerUp = () => {
    drawingRef.current = false;
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    hasSignedRef.current = false;
    setHasSigned(false);
  };

  const onBankbookSelected = (file: File | null) => {
    if (!file) {
      setBankbook(null);
      setBankbookPreview(null);
      return;
    }
    if (!BANKBOOK_TYPES.includes(file.type)) {
      toast("통장 사본은 PDF, PNG, JPEG 형식만 가능합니다.", "error");
      return;
    }
    if (file.size > BANKBOOK_MAX_BYTES) {
      toast("통장 사본 파일이 너무 큽니다 (최대 5MB).", "error");
      return;
    }
    setBankbook(file);
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => setBankbookPreview((e.target?.result as string) ?? null);
      reader.readAsDataURL(file);
    } else {
      setBankbookPreview(null);
    }
  };

  async function fileToDataUrl(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(f);
    });
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    // Field-level validation errors stay as toasts (transient, single
    // missing field). Submit-time failures (P0-C-P1-7) move to the
    // inline panel below the button so the recovery guide stays put.
    if (!name.trim()) {
      toast("성명을 입력하세요.", "error");
      return;
    }
    if (!phone.replace(/\D/g, "")) {
      toast("연락처를 입력하세요.", "error");
      return;
    }
    if (!email.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) {
      toast("올바른 이메일을 입력하세요.", "error");
      return;
    }
    const rrnDigits = rrn.replace(/\D/g, "");
    if (rrnDigits.length !== 13) {
      toast("주민등록번호는 13자리여야 합니다.", "error");
      return;
    }
    if (!institution.trim()) {
      toast("소속을 입력하세요.", "error");
      return;
    }
    if (!bank) {
      toast("은행을 선택하세요.", "error");
      return;
    }
    if (!account.trim()) {
      toast("계좌번호를 입력하세요.", "error");
      return;
    }
    if (!bankbook) {
      toast("통장 사본을 첨부해 주세요.", "error");
      return;
    }
    if (!hasSigned) {
      toast("전자서명을 입력해 주세요.", "error");
      return;
    }

    const canvas = canvasRef.current!;
    const signaturePng = canvas.toDataURL("image/png");

    setSubmitStage("encoding");
    let bankbookDataUrl: string;
    try {
      bankbookDataUrl = await fileToDataUrl(bankbook);
    } catch {
      setSubmitError({
        title: "통장 사본을 읽는 중 오류가 발생했습니다",
        detail: "다른 파일로 다시 첨부해 주세요. 문제가 계속되면 사진 크기를 줄이거나 PDF 로 변환해 보세요.",
        showRecoverySteps: false,
      });
      setSubmitStage("idle");
      return;
    }

    setSubmitStage("sending");
    try {
      const res = await fetch(`/api/payment-info/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim(),
          rrn: rrn.trim(),
          bankName: bank,
          accountNumber: account.trim().replace(/\s+/g, ""),
          accountHolder: (holder || name).trim(),
          institution: institution.trim(),
          signaturePng,
          bankbook: {
            dataUrl: bankbookDataUrl,
            fileName: bankbook.name,
            mimeType: bankbook.type,
          },
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = body?.error ?? "제출에 실패했습니다.";
        // 429 = rate limit; show retry-after if present. Otherwise
        // generic recovery guide.
        const isRateLimit = res.status === 429;
        setSubmitError({
          title: isRateLimit
            ? "잠시 후 다시 시도해 주세요"
            : "제출에 실패했습니다",
          detail: message,
          showRecoverySteps: !isRateLimit,
        });
        setSubmitStage("idle");
        return;
      }

      toast("정산 정보가 제출되었습니다.", "success");
      // Leave submitStage='sending' so the bar stays full while
      // router.refresh() repaints — avoids a moment of "idle" with the
      // form re-enabled before the success view loads.
      router.refresh();
    } catch {
      setSubmitError({
        title: "전송 중 연결이 끊어졌습니다",
        detail: "통장 사본 파일이 클수록 시간이 더 걸립니다. 아래 안내를 따라 다시 시도해 주세요.",
        showRecoverySteps: true,
      });
      setSubmitStage("idle");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="rounded-xl border border-border bg-white p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">👤 참가자 정보</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="name" className="mb-1 block text-xs font-medium text-foreground">
              성명 <span className="text-red-500">*</span>
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              required
              autoComplete="name"
            />
          </div>
          <div>
            <label htmlFor="phone" className="mb-1 block text-xs font-medium text-foreground">
              연락처 <span className="text-red-500">*</span>
            </label>
            <input
              id="phone"
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value)}
              placeholder="010-1234-5678"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-mono text-foreground focus:border-primary focus:outline-none"
              required
              autoComplete="tel"
              maxLength={13}
            />
          </div>
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium text-foreground">
              이메일 <span className="text-red-500">*</span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@snu.ac.kr"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              required
              autoComplete="email"
            />
          </div>
          <div>
            <label htmlFor="institution" className="mb-1 block text-xs font-medium text-foreground">
              소속 <span className="text-red-500">*</span>
            </label>
            <input
              id="institution"
              type="text"
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              placeholder="예: 서울대학교"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              required
            />
          </div>
          <div className="col-span-2">
            <label htmlFor="rrn" className="mb-1 block text-xs font-medium text-foreground">
              주민등록번호 <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                id="rrn"
                // P0-Κ: type="text" + CSS -webkit-text-security:disc.
                // The previous type="password" triggered iOS Safari's
                // iCloud-Keychain "save password?" prompt — which would
                // have stored the user's RRN as a password. CSS masking
                // gives the same shoulder-surfing protection without
                // marking the field as a credential.
                type="text"
                inputMode="numeric"
                // 1Password / Bitwarden also detect "password-shaped"
                // fields. Mark explicitly as not-a-credential.
                autoComplete="off"
                data-form-type="other"
                name="participant-id-number"
                value={rrn}
                onChange={(e) => handleRrnChange(e.target.value)}
                placeholder="XXXXXX-XXXXXXX"
                style={{
                  WebkitTextSecurity: rrnVisible ? "none" : "disc",
                  // Firefox doesn't support -webkit-text-security; falls
                  // back to plain text. Acceptable — Firefox mobile share
                  // is small enough that one-button-toggle covers it.
                } as React.CSSProperties}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 pr-10 text-sm font-mono text-foreground focus:border-primary focus:outline-none"
                required
                maxLength={14}
              />
              <button
                type="button"
                onClick={() => setRrnVisible((v) => !v)}
                aria-label={rrnVisible ? "주민등록번호 숨기기" : "주민등록번호 표시"}
                aria-pressed={rrnVisible}
                className="absolute inset-y-0 right-2 flex items-center px-2 text-muted hover:text-foreground"
              >
                {/* SVG eye / eye-off icons — emoji 🙈/👁 broke on
                    older Android phones (font fallback to ▢) and
                    screen readers read them as "monkey" / "eye". */}
                {rrnVisible ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted">
          주민등록번호는 AES-256 암호화되어 저장되며, 행정 제출용 엑셀 파일 생성 시에만 복호화됩니다.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-white p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">🏦 계좌 정보</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="bank" className="mb-1 block text-xs font-medium text-foreground">
              은행명 <span className="text-red-500">*</span>
            </label>
            <select
              id="bank"
              value={bank}
              onChange={(e) => setBank(e.target.value)}
              required
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="" disabled>
                — 선택해 주세요 —
              </option>
              {BANKS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="account" className="mb-1 block text-xs font-medium text-foreground">
              계좌번호 <span className="text-red-500">*</span>
            </label>
            <input
              id="account"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="110-545-811341"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-mono text-foreground focus:border-primary focus:outline-none"
              required
            />
          </div>
        </div>
        <div>
          <label htmlFor="holder" className="mb-1 block text-xs font-medium text-foreground">
            예금주
          </label>
          <input
            id="holder"
            type="text"
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
            placeholder={name || "비워두면 성명과 동일"}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <p className="mt-1 text-xs text-muted">본인 명의 계좌여야 합니다.</p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-foreground">
            통장 사본 <span className="text-red-500">*</span>
          </label>
          <input
            ref={bankbookInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,image/png,image/jpeg,application/pdf"
            onChange={(e) => onBankbookSelected(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-foreground file:mr-3 file:rounded-lg file:border file:border-border file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground file:hover:bg-muted/30"
          />
          {bankbook && (
            <div className="mt-2 flex items-center gap-3 rounded-lg border border-border bg-muted/10 p-2">
              {bankbookPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={bankbookPreview}
                  alt="통장 사본 미리보기"
                  className="h-14 w-auto rounded border border-border object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded border border-border bg-white text-xs text-muted">
                  PDF
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{bankbook.name}</p>
                <p className="text-[11px] text-muted">
                  {(bankbook.size / 1024).toFixed(1)} KB
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (bankbookInputRef.current) bankbookInputRef.current.value = "";
                  onBankbookSelected(null);
                }}
                className="text-xs text-muted hover:text-foreground"
              >
                지우기
              </button>
            </div>
          )}
          <p className="mt-1 text-[11px] text-muted">
            PDF 또는 사진(JPEG, PNG) · 최대 5MB · 비공개 저장소에 보관됩니다.
            <br />
            <span className="text-foreground/70">
              스마트폰으로 통장 첫 페이지를 직접 촬영하셔도 됩니다.
            </span>
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-white p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">✍️ 전자서명 <span className="text-red-500">*</span></h2>
          <button
            type="button"
            onClick={clearSignature}
            className="text-xs text-muted hover:text-foreground"
          >
            지우기
          </button>
        </div>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          // 모바일에서 한국어 흘림 서명이 좁아 보이지 않도록 170px 로
          // 키움. 캔버스 init 은 clientHeight 기반이라 별도 조정 불필요.
          style={{ width: "100%", height: "170px", touchAction: "none" }}
          className="block rounded-lg border border-dashed border-border bg-white"
        />
        <p className="text-xs text-muted">
          크게, 천천히 그려주세요. 마음에 들지 않으면 우측 상단 &ldquo;지우기&rdquo;로
          다시 그릴 수 있습니다. 청구 양식의 수령인 서명란에 자동 삽입됩니다.
        </p>
      </div>

      {submitError && (
        <div
          role="alert"
          className="rounded-xl border-2 border-red-200 bg-red-50 p-4 text-sm text-red-900 leading-relaxed"
        >
          <div className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5">⚠</span>
            <div className="flex-1">
              <p className="font-semibold">{submitError.title}</p>
              <p className="mt-1 text-red-800">{submitError.detail}</p>
              {submitError.showRecoverySteps && (
                <ul className="mt-3 list-disc pl-4 text-xs text-red-800/90 space-y-1">
                  <li>Wi-Fi 연결을 확인한 뒤 다시 제출해 주세요.</li>
                  <li>통장 사본 사진을 다시 첨부 (2MB 이하 권장).</li>
                  <li>그래도 실패하면 담당 연구원에게 메일로 통장 사본·계좌 정보를 직접 보내주세요.</li>
                </ul>
              )}
              <button
                type="button"
                onClick={() => setSubmitError(null)}
                className="mt-3 text-xs text-red-700 underline hover:text-red-900"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitStage === "encoding"
            ? "통장 사본 처리 중…"
            : submitStage === "sending"
              ? "전송 중…"
              : "정산 정보 제출"}
        </button>
        {submitting && (
          <div
            className="mt-2 h-1 overflow-hidden rounded-full bg-muted/30"
            role="progressbar"
            aria-label="제출 진행 중"
          >
            {/* fetch() 가 upload progress 를 노출하지 않으므로 indeterminate
                animated bar 로 사용자 안심 (특히 5MB PDF 업로드 30초 케이스).
                styled-jsx 가 keyframe 이름을 해시하므로 inline keyframes +
                animation 을 한 stylesheet 으로 묶어 둔다. */}
            <div
              className="h-full w-1/3 rounded-full bg-primary"
              style={{ animation: "paymentSubmitProgress 1.2s ease-in-out infinite" }}
            />
          </div>
        )}
        <style>{`
          @keyframes paymentSubmitProgress {
            0%   { transform: translateX(-110%); }
            50%  { transform: translateX(40%); }
            100% { transform: translateX(310%); }
          }
        `}</style>
      </div>
    </form>
  );
}
