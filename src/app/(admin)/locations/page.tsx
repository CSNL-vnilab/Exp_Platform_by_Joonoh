import { requireAdmin } from "@/lib/auth/role";
import { createClient } from "@/lib/supabase/server";
import { LocationsManager, AddLocationButton } from "./locations-manager";
import type { ExperimentLocation } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function LocationsPage() {
  await requireAdmin();

  const supabase = await createClient();
  const { data } = await supabase
    .from("experiment_locations")
    .select("*")
    .order("name", { ascending: true });

  const locations = (data ?? []) as ExperimentLocation[];

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">실험 장소 관리</h1>
          <p className="mt-1 text-sm text-muted">
            실험이 진행되는 장소 정보를 관리합니다. 참여자에게 표시되는 주소와 네이버 지도 링크를 설정하세요.
          </p>
        </div>
        <AddLocationButton />
      </div>
      <LocationsManager initialLocations={locations} />
    </div>
  );
}
