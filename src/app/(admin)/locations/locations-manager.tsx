"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LocationModal } from "@/components/location-modal";
import type { ExperimentLocation } from "@/types/database";

// ---------------------------------------------------------------------------
// Add location button (standalone, used from page header)
// ---------------------------------------------------------------------------

export function AddLocationButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  function handleSaved() {
    startTransition(() => router.refresh());
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>+ 장소 추가</Button>
      <LocationModal
        open={open}
        onClose={() => setOpen(false)}
        onSaved={handleSaved}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main manager (card list + edit/delete)
// ---------------------------------------------------------------------------

interface LocationsManagerProps {
  initialLocations: ExperimentLocation[];
}

export function LocationsManager({ initialLocations }: LocationsManagerProps) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const [editTarget, setEditTarget] = useState<ExperimentLocation | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function handleEditSaved() {
    startTransition(() => router.refresh());
  }

  async function handleDelete(loc: ExperimentLocation) {
    const confirmed = await confirm({
      title: "장소 삭제",
      message: (
        <div className="space-y-1">
          <p>
            <span className="font-medium text-foreground">{loc.name}</span> 장소를
            삭제하시겠습니까?
          </p>
        </div>
      ),
      detail: "이 작업은 되돌릴 수 없습니다.",
      confirmLabel: "삭제",
      danger: true,
    });
    if (!confirmed) return;

    setDeletingId(loc.id);
    const res = await fetch(`/api/locations/${loc.id}`, { method: "DELETE" });
    setDeletingId(null);

    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: "삭제에 실패했습니다." }));
      toast(j.error ?? "삭제에 실패했습니다.", "error");
      return;
    }

    toast("장소가 삭제되었습니다", "success");
    startTransition(() => router.refresh());
  }

  if (initialLocations.length === 0) {
    return (
      <Card>
        <EmptyState
          title="등록된 장소가 없습니다."
          description={'오른쪽 상단의 "장소 추가" 버튼으로 추가해 보세요.'}
          inset="card"
        />
      </Card>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {initialLocations.map((loc) => {
          const busy = deletingId === loc.id;
          return (
            <Card key={loc.id} className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-foreground truncate">{loc.name}</h3>
                <div className="mt-1 flex flex-col gap-0.5">
                  {loc.address_lines.map((line, i) => (
                    <p key={i} className="text-sm text-muted">
                      {line}
                    </p>
                  ))}
                </div>
                {loc.naver_url && (
                  <a
                    href={loc.naver_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <MapPinIcon className="h-3.5 w-3.5" />
                    네이버 지도에서 보기
                  </a>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditTarget(loc);
                    setEditOpen(true);
                  }}
                >
                  수정
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy}
                  onClick={() => handleDelete(loc)}
                >
                  삭제
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <LocationModal
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
          setEditTarget(null);
        }}
        initial={editTarget}
        onSaved={handleEditSaved}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

function MapPinIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
      />
    </svg>
  );
}
