import { requireUser } from "@/lib/auth/role";
import { ParticipantsList } from "./participants-list";

export const dynamic = "force-dynamic";

export default async function ParticipantsPage() {
  // Admins and researchers both see this page; researchers get a name-less
  // view driven by the `role` prop. `requireUser` already redirects to
  // /login when no session is present.
  const profile = await requireUser();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">참여자 관리</h1>
        <p className="mt-1 text-sm text-muted">
          연구실 참여자의 클래스 상태와 예약 이력을 확인합니다.
        </p>
      </div>
      <ParticipantsList role={profile.role} />
    </div>
  );
}
