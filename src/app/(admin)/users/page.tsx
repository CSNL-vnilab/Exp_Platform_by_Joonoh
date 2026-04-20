import { requireAdmin } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { UsersTable } from "./users-table";
import { AddUserButton } from "./add-user-form";
import { PendingRequestsPanel, type PendingRequest } from "./pending-requests";
import type { Profile } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireAdmin();

  const supabase = await createClient();
  const { data: profilesData } = await supabase
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });

  // Use service-role for pending requests — no researcher-facing RLS policy
  // needs to exist, and fetching here avoids an extra client call.
  const admin = createAdminClient();
  const { data: requestsData } = await admin
    .from("registration_requests")
    .select("id, username, display_name, requested_at")
    .eq("status", "pending")
    .order("requested_at", { ascending: true });

  const profiles = (profilesData ?? []) as Profile[];
  const requests = (requestsData ?? []) as PendingRequest[];

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">사용자 관리</h1>
          <p className="mt-1 text-sm text-muted">
            연구원 계정을 직접 발급하거나, 기존 계정의 역할을 변경할 수 있습니다.
          </p>
        </div>
        <AddUserButton />
      </div>
      <PendingRequestsPanel requests={requests} />
      <UsersTable profiles={profiles} currentUserId={me.id} />
    </div>
  );
}
