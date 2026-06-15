"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Promise-based confirm dialog
//
// Replaces native `window.confirm()` for destructive admin actions with a
// styled <dialog>-based modal that can spell out the side-effects of the
// action ("a cancellation email is sent / the calendar event is deleted").
//
// Usage:
//   const confirm = useConfirm();
//   async function onDelete() {
//     const ok = await confirm({ title: "삭제", message: "...", danger: true });
//     if (!ok) return;            // user cancelled — no side-effects
//     await doDelete();           // only runs when explicitly confirmed
//   }
//
// The dialog uses showModal() so it sits in the browser top-layer; when one
// is already open from a parent Modal, this confirm renders above it. Only a
// single confirm is live at a time (the provider holds one resolver).
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  /** Heading shown at the top of the dialog. */
  title: string;
  /** Primary body. Plain string or rich node (participant/time details, etc). */
  message?: ReactNode;
  /** Secondary line spelling out side-effects ("email is sent…"). */
  detail?: ReactNode;
  /** Confirm-button label. Defaults to "확인". */
  confirmLabel?: string;
  /** Cancel-button label. Defaults to "취소". */
  cancelLabel?: string;
  /** When true (default) the confirm button uses the danger variant. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // Only one confirm at a time. If a previous one is somehow still
      // open, resolve it as cancelled before replacing it.
      setPending((prev) => {
        prev?.resolve(false);
        return { ...opts, resolve };
      });
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setPending((prev) => {
      prev?.resolve(value);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        pending={pending}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingConfirm | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const open = pending !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      // Focus the confirm action for keyboard users.
      confirmBtnRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  const danger = pending?.danger ?? true;
  const confirmLabel = pending?.confirmLabel ?? "확인";
  const cancelLabel = pending?.cancelLabel ?? "취소";

  return (
    <dialog
      ref={dialogRef}
      // Native cancel fires on Esc and on backdrop dismissal; treat both as
      // "no". preventDefault keeps the close path going through onCancel so
      // the promise always resolves exactly once.
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      // z-[60] keeps the confirm above any other app modal (toasts z-50).
      className="z-[60] m-auto w-full max-w-md rounded-xl border border-border bg-white p-0 shadow-overlay backdrop:bg-black/40"
      aria-labelledby="confirm-dialog-title"
    >
      {pending && (
        <div className="flex flex-col gap-4 px-6 py-5">
          <h2
            id="confirm-dialog-title"
            className="text-lg font-semibold text-foreground"
          >
            {pending.title}
          </h2>
          {pending.message != null && (
            <div className="text-sm text-foreground">{pending.message}</div>
          )}
          {pending.detail != null && (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                danger
                  ? "border-danger/30 bg-danger/5 text-danger-700"
                  : "border-border bg-card text-muted"
              }`}
            >
              {pending.detail}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              ref={confirmBtnRef}
              type="button"
              variant={danger ? "danger" : "primary"}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return ctx;
}
