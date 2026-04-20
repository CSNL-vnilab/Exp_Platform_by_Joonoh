"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { USERNAME_REGEX, PASSWORD_REGEX } from "@/lib/auth/username";
import type { UserRole } from "@/types/database";

function random6Digit(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return (arr[0] % 1_000_000).toString().padStart(6, "0");
}

function randomAdminPassword(length = 14): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}

export function AddUserButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>+ 계정 발급</Button>
      <AddUserModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function AddUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("researcher");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [justCreated, setJustCreated] = useState<{ username: string; password: string } | null>(null);

  function reset() {
    setUsername("");
    setDisplayName("");
    setEmail("");
    setPhone("");
    setPassword("");
    setRole("researcher");
    setError("");
    setJustCreated(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function onRoleChange(next: UserRole) {
    setRole(next);
    // When switching role, wipe incompatible password to keep UI honest.
    if (next === "researcher" && !PASSWORD_REGEX.test(password)) setPassword("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const id = username.trim();
    if (!USERNAME_REGEX.test(id)) return setError("ID는 영문 3~4자여야 합니다.");
    if (!displayName.trim()) return setError("이름을 입력해 주세요.");
    const emailTrimmed = email.trim();
    if (!emailTrimmed) return setError("이메일을 입력해 주세요.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
      return setError("올바른 이메일 형식이 아닙니다. (예: researcher@example.com)");
    }
    const phoneTrimmed = phone.trim();
    if (!phoneTrimmed) return setError("전화번호를 입력해 주세요.");
    if (!/^01[0-9]-?\d{3,4}-?\d{4}$/.test(phoneTrimmed)) {
      return setError("올바른 전화번호 형식이 아닙니다. (예: 010-1234-5678)");
    }
    if (role === "researcher" && !PASSWORD_REGEX.test(password)) {
      return setError("연구원 비밀번호는 숫자 6자리여야 합니다.");
    }
    if (role === "admin" && password.length < 8) {
      return setError("관리자 비밀번호는 8자 이상이어야 합니다.");
    }

    setLoading(true);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: id,
        password,
        displayName: displayName.trim(),
        role,
        contactEmail: emailTrimmed,
        phone: phoneTrimmed,
      }),
    });
    setLoading(false);

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "계정 생성에 실패했습니다.");
      return;
    }

    setJustCreated({ username: id.toLowerCase(), password });
    toast("계정이 생성되었습니다", "success");
    router.refresh();
  }

  async function copyCredentials() {
    if (!justCreated) return;
    const text = `ID: ${justCreated.username}\n비밀번호: ${justCreated.password}`;
    try {
      await navigator.clipboard.writeText(text);
      toast("로그인 정보가 복사되었습니다", "success");
    } catch {
      toast("복사에 실패했습니다. 수동으로 복사해 주세요.", "error");
    }
  }

  const passwordGenerator = role === "researcher" ? random6Digit : randomAdminPassword;
  const passwordHint =
    role === "researcher"
      ? "연구원 비밀번호는 숫자 6자리입니다."
      : "관리자 비밀번호는 8자 이상입니다. 생성 후 다시 확인할 수 없습니다.";

  return (
    <Modal open={open} onClose={handleClose} title="계정 발급">
      {justCreated ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            아래 정보를 본인에게 전달하세요. <b>비밀번호는 다시 볼 수 없습니다.</b>
          </p>
          <div className="rounded-lg border border-border bg-card p-4 font-mono text-sm">
            <div>ID: {justCreated.username}</div>
            <div>비밀번호: {justCreated.password}</div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={copyCredentials}>
              복사
            </Button>
            <Button onClick={handleClose}>닫기</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            id="new-username"
            label="ID (영문 3~4자)"
            type="text"
            placeholder="예: abc 또는 kimj"
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/[^A-Za-z]/g, ""))}
            required
            autoComplete="off"
            minLength={3}
            maxLength={4}
            pattern="[A-Za-z]{3,4}"
          />
          <Input
            id="new-name"
            label="이름"
            type="text"
            placeholder="홍길동"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            autoComplete="off"
            maxLength={60}
          />
          <Input
            id="new-email"
            label="이메일"
            type="email"
            placeholder="researcher@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="off"
            maxLength={254}
          />
          <Input
            id="new-phone"
            label="전화번호"
            type="tel"
            placeholder="010-1234-5678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            autoComplete="off"
            maxLength={13}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-role" className="text-sm font-medium text-foreground">
              역할
            </label>
            <select
              id="new-role"
              value={role}
              onChange={(e) => onRoleChange(e.target.value as UserRole)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="researcher">연구원</option>
              <option value="admin">관리자</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-password" className="text-sm font-medium text-foreground">
              비밀번호
            </label>
            <div className="flex gap-2">
              <input
                id="new-password"
                type="text"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                value={password}
                onChange={(e) => {
                  const next =
                    role === "researcher"
                      ? e.target.value.replace(/\D/g, "").slice(0, 6)
                      : e.target.value;
                  setPassword(next);
                }}
                required
                minLength={role === "researcher" ? 6 : 8}
                maxLength={role === "researcher" ? 6 : 128}
                autoComplete="off"
                inputMode={role === "researcher" ? "numeric" : "text"}
                pattern={role === "researcher" ? "[0-9]{6}" : undefined}
                placeholder={role === "researcher" ? "숫자 6자리" : "8자 이상"}
              />
              <Button type="button" variant="secondary" onClick={() => setPassword(passwordGenerator())}>
                생성
              </Button>
            </div>
            <p className="text-xs text-muted">{passwordHint}</p>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2 mt-2">
            <Button type="button" variant="secondary" onClick={handleClose} disabled={loading}>
              취소
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "생성 중..." : "계정 만들기"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
