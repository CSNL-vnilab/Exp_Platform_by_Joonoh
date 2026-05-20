import { requireAdmin } from "@/lib/auth/role";
import { BlacklistRequestsList } from "./blacklist-requests-list";

export const dynamic = "force-dynamic";

// Admin approval queue for researcher-submitted blacklist requests
// (migration 00061). requireAdmin redirects non-admins back to the
// dashboard, so the page itself can assume admin context.
export default async function BlacklistRequestsPage() {
  await requireAdmin();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          블랙리스트 승인 큐
        </h1>
        <p className="mt-1 text-sm text-muted">
          연구원이 제출한 블랙리스트 등록 요청을 검토하고 승인/반려합니다.
          승인 시 해당 참여자의 클래스가 즉시 블랙리스트로 변경되며,
          향후 홍보 메일 발송 대상에서 자동 제외됩니다.
        </p>
      </div>
      <BlacklistRequestsList />
    </div>
  );
}
