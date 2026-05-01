"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { USERNAME_REGEX, PASSWORD_REGEX } from "@/lib/auth/username";
import { BRAND_NAME, BRAND_SUBTITLE, BRAND_PI, BRAND_CONTACT_EMAIL, isBrandContactEmailPlaceholder } from "@/lib/branding";

export default function SignupPage() {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const id = username.trim();
    if (!USERNAME_REGEX.test(id)) {
      setError("ID는 영문 3~4자만 사용할 수 있습니다.");
      return;
    }
    if (!PASSWORD_REGEX.test(password)) {
      setError("비밀번호는 숫자 6자리여야 합니다.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    if (!displayName.trim()) {
      setError("이름을 입력해 주세요.");
      return;
    }
    const emailTrimmed = email.trim();
    if (!emailTrimmed) {
      setError("이메일을 입력해 주세요.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
      setError("올바른 이메일 형식이 아닙니다. (예: researcher@example.com)");
      return;
    }
    const phoneTrimmed = phone.trim();
    if (!phoneTrimmed) {
      setError("전화번호를 입력해 주세요.");
      return;
    }
    if (!/^01[0-9]-?\d{3,4}-?\d{4}$/.test(phoneTrimmed)) {
      setError("올바른 전화번호 형식이 아닙니다. (예: 010-1234-5678)");
      return;
    }

    setLoading(true);
    const res = await fetch("/api/registration-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: id,
        password,
        displayName: displayName.trim(),
        contactEmail: emailTrimmed,
        phone: phoneTrimmed,
      }),
    });
    setLoading(false);

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "요청 접수에 실패했습니다.");
      return;
    }

    setSubmitted(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-card px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">{BRAND_NAME}</h1>
          <p className="mt-2 text-xs text-muted leading-snug">
            {BRAND_SUBTITLE}
            {BRAND_PI && (
              <>
                <br />
                {BRAND_PI}
              </>
            )}
          </p>
          <p className="mt-3 text-sm text-muted">연구원 계정 등록 요청</p>
        </div>
        <Card>
          {submitted ? (
            <div className="flex flex-col gap-4 text-center">
              <h2 className="text-lg font-semibold text-foreground">요청이 접수되었습니다</h2>
              <p className="text-sm text-muted">
                관리자 승인 후 입력하신 ID와 비밀번호로 로그인할 수 있습니다.
                {!isBrandContactEmailPlaceholder() && (
                  <>
                    <br />
                    관리자에게 승인 요청 알림이 <b>{BRAND_CONTACT_EMAIL}</b>으로
                    발송되었습니다.
                  </>
                )}
              </p>
              <Link href="/login" className="text-sm text-primary underline">
                로그인 페이지로 이동
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input
                id="username"
                label="ID (영문 3~4자)"
                type="text"
                placeholder="예: abc 또는 kimj"
                value={username}
                onChange={(e) => setUsername(e.target.value.replace(/[^A-Za-z]/g, ""))}
                required
                autoComplete="username"
                minLength={3}
                maxLength={4}
                pattern="[A-Za-z]{3,4}"
                autoCapitalize="none"
              />
              <Input
                id="displayName"
                label="이름"
                type="text"
                placeholder="홍길동"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                autoComplete="name"
                maxLength={60}
              />
              <Input
                id="email"
                label="이메일"
                type="email"
                placeholder="researcher@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                maxLength={254}
              />
              <Input
                id="phone"
                label="전화번호"
                type="tel"
                placeholder="010-1234-5678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                autoComplete="tel"
                maxLength={13}
              />
              <Input
                id="password"
                label="비밀번호 (숫자 6자리)"
                type="password"
                placeholder="••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                autoComplete="new-password"
              />
              <Input
                id="passwordConfirm"
                label="비밀번호 확인"
                type="password"
                placeholder="••••••"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                autoComplete="new-password"
              />
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button type="submit" disabled={loading} className="w-full mt-2">
                {loading ? "요청 중..." : "등록 요청 보내기"}
              </Button>
            </form>
          )}
        </Card>
        <p className="mt-4 text-center text-sm text-muted">
          이미 계정이 있으신가요?{" "}
          <Link href="/login" className="text-primary underline">
            로그인
          </Link>
        </p>
      </div>
    </div>
  );
}
