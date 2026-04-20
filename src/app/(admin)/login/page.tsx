"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { USERNAME_REGEX, toInternalEmail } from "@/lib/auth/username";
import { BRAND_NAME, BRAND_SUBTITLE, BRAND_PI } from "@/lib/branding";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const id = username.trim();
    if (!USERNAME_REGEX.test(id)) {
      setError("ID는 영문 3~4자만 사용할 수 있습니다.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: toInternalEmail(id),
      password,
    });

    if (authError) {
      setError("ID 또는 비밀번호가 올바르지 않습니다.");
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-card px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">{BRAND_NAME}</h1>
          <p className="mt-2 text-xs text-muted leading-snug whitespace-pre-line">
            {BRAND_SUBTITLE}
            {BRAND_PI && `\n${BRAND_PI}`}
          </p>
        </div>
        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              id="username"
              label="ID"
              type="text"
              placeholder="영문 3~4자"
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
              id="password"
              label="비밀번호"
              type="password"
              placeholder="비밀번호를 입력하세요"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={loading} className="w-full mt-2">
              {loading ? "로그인 중..." : "로그인"}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-muted">
          계정이 없으신가요?{" "}
          <Link href="/signup" className="text-primary underline">
            연구원 등록 요청
          </Link>
        </p>
      </div>
    </div>
  );
}
