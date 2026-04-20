import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTimeKR, formatTimeKR } from "@/lib/utils/date";
import type { Experiment } from "@/types/database";
import { z } from "zod/v4";
import { participantSchema } from "@/lib/utils/validation";

type ParticipantData = z.infer<typeof participantSchema>;

interface SerializedSlot {
  slot_start: string;
  slot_end: string;
  session_number?: number;
}

interface BookingSummaryProps {
  experiment: Experiment;
  participant: ParticipantData;
  slots: SerializedSlot[];
}

const genderLabels: Record<string, string> = {
  male: "남성",
  female: "여성",
  other: "기타",
};

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className="w-24 shrink-0 text-sm text-muted">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

export function BookingSummary({
  experiment,
  participant,
  slots,
}: BookingSummaryProps) {
  const sortedSlots = [...slots].sort(
    (a, b) => (a.session_number ?? 1) - (b.session_number ?? 1)
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>실험 정보</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border">
            <InfoRow label="실험명" value={experiment.title} />
            {experiment.description && (
              <InfoRow label="설명" value={experiment.description} />
            )}
            <InfoRow
              label="소요 시간"
              value={`${experiment.session_duration_minutes}분`}
            />
            {experiment.participation_fee > 0 && (
              <InfoRow
                label="참여비"
                value={`${experiment.participation_fee.toLocaleString()}원`}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>참여자 정보</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border">
            <InfoRow label="이름" value={participant.name} />
            <InfoRow label="전화번호" value={participant.phone} />
            <InfoRow label="이메일" value={participant.email} />
            <InfoRow label="성별" value={genderLabels[participant.gender] ?? participant.gender} />
            <InfoRow label="생년월일" value={participant.birthdate} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>예약 시간</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {sortedSlots.map((slot, index) => (
              <div
                key={slot.slot_start}
                className="rounded-lg border border-border bg-card p-3"
              >
                {experiment.session_type === "multi" && (
                  <p className="mb-1 text-xs font-semibold text-primary">
                    {slot.session_number ?? index + 1}회차
                  </p>
                )}
                <p className="text-sm font-medium text-foreground">
                  {formatDateTimeKR(slot.slot_start)}
                </p>
                <p className="text-xs text-muted">
                  ~ {formatTimeKR(new Date(slot.slot_end))}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
