"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v4";
import { participantSchema } from "@/lib/utils/validation";
import { GENDER_OPTIONS } from "@/lib/utils/constants";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type ParticipantFormData = z.infer<typeof participantSchema>;

interface ParticipantFormProps {
  onSubmit: (data: ParticipantFormData) => void;
  initialData?: Partial<ParticipantFormData>;
}

// YY pivot: two-digit years ≤ (current year 2-digit) belong to 2000s, else 1900s.
// e.g. in 2026, "25" → 2025, "26" → 2026, "27" → 1927.
function yymmddToIsoDate(input: string): string | null {
  if (!/^\d{6}$/.test(input)) return null;
  const yy = Number(input.slice(0, 2));
  const mm = Number(input.slice(2, 4));
  const dd = Number(input.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const currentTwoDigit = new Date().getFullYear() % 100;
  const century = yy <= currentTwoDigit ? 2000 : 1900;
  const year = century + yy;
  const iso = `${String(year).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const d = new Date(iso + "T00:00:00Z");
  // Round-trip guard against e.g. "990231"
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== mm ||
    d.getUTCDate() !== dd
  ) {
    return null;
  }
  return iso;
}

function isoDateToYymmdd(iso: string | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
}

export function ParticipantForm({ onSubmit, initialData }: ParticipantFormProps) {
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<ParticipantFormData>({
    resolver: zodResolver(participantSchema),
    defaultValues: initialData,
  });

  const [yymmdd, setYymmdd] = useState(() => isoDateToYymmdd(initialData?.birthdate));
  const [birthError, setBirthError] = useState<string | null>(null);

  // Register birthdate as a controlled value synced from yymmdd.
  register("birthdate");

  useEffect(() => {
    if (yymmdd.length === 0) {
      setValue("birthdate", "");
      setBirthError(null);
      return;
    }
    if (yymmdd.length < 6) {
      setBirthError(null);
      return;
    }
    const iso = yymmddToIsoDate(yymmdd);
    if (iso) {
      setValue("birthdate", iso, { shouldValidate: true });
      setBirthError(null);
    } else {
      setValue("birthdate", "");
      setBirthError("올바른 생년월일 6자리를 입력해 주세요 (예: 990315)");
    }
  }, [yymmdd, setValue]);

  const previewIso = yymmddToIsoDate(yymmdd);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <Input
        id="name"
        label="이름"
        placeholder="홍길동"
        error={errors.name?.message}
        {...register("name")}
      />

      <Input
        id="phone"
        label="전화번호"
        placeholder="010-1234-5678"
        type="tel"
        inputMode="tel"
        error={errors.phone?.message}
        {...register("phone")}
      />

      <Input
        id="email"
        label="이메일"
        placeholder="example@email.com"
        type="email"
        inputMode="email"
        error={errors.email?.message}
        {...register("email")}
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">성별</span>
        <div className="flex gap-4">
          {GENDER_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2"
            >
              <input
                type="radio"
                value={option.value}
                className="h-4 w-4 accent-primary"
                {...register("gender")}
              />
              <span className="text-sm text-foreground">{option.label}</span>
            </label>
          ))}
        </div>
        {errors.gender && (
          <p className="text-xs text-danger">{errors.gender.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="birthdate-yymmdd" className="text-sm font-medium text-foreground">
          생년월일 (YYMMDD)
        </label>
        <input
          id="birthdate-yymmdd"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          autoComplete="bday"
          placeholder="예: 990315"
          value={yymmdd}
          onChange={(e) => setYymmdd(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className={`w-full rounded-lg border bg-white px-3 py-2 font-mono text-sm tracking-wider text-foreground placeholder:text-muted focus:outline-none focus:ring-2 ${
            birthError || errors.birthdate
              ? "border-danger focus:border-danger focus:ring-danger/20"
              : "border-border focus:border-primary focus:ring-primary/20"
          }`}
        />
        {previewIso && !birthError && (
          <p className="text-xs text-muted">→ {previewIso}</p>
        )}
        {(birthError || errors.birthdate?.message) && (
          <p className="text-xs text-danger">
            {birthError ?? errors.birthdate?.message}
          </p>
        )}
      </div>

      <Button type="submit" size="lg" className="w-full">
        다음 단계
      </Button>
    </form>
  );
}
