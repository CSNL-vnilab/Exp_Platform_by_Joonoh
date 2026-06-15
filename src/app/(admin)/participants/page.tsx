import { requireUser } from "@/lib/auth/role";
import { ParticipantsList } from "./participants-list";

export const dynamic = "force-dynamic";

export default async function ParticipantsPage() {
  // Admins and researchers both see the full roster + 홍보 발송 workflow
  // (2026-05-19 directive). `requireUser` redirects to /login when no
  // session is present and blocks disabled accounts.
  await requireUser();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">참여자 관리</h1>
        <p className="mt-1 text-sm text-muted">
          연구실 참여자의 이름·연락처·참여 실험·클래스를 확인하고, 선택한
          참여자에게 홍보 메일을 발송합니다.
        </p>
      </div>
      <ParticipantsList />
    </div>
  );
}
