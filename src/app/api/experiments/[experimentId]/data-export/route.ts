import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";

// GET /api/experiments/:experimentId/data-export
//
// Researcher-only endpoint that lists every JSON block uploaded for the
// experiment and returns short-lived signed URLs for download. Streams
// back as { files: [{ path, signed_url, size_bytes }...] } so the admin
// UI can render a download list or a researcher can pipe wget over the
// array.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;

  const access = await requireExperimentAccess(experimentId, {
    extraColumns: "experiment_mode",
  });
  if (access instanceof NextResponse) return access;
  const { admin } = access;
  const exp = access.experiment as unknown as {
    id: string;
    created_by: string | null;
    experiment_mode: string | null;
  };

  if (exp.experiment_mode === "offline") {
    return NextResponse.json(
      { error: "Experiment is offline-only; no runtime data" },
      { status: 400 },
    );
  }

  // Walk subject folders under experiment-data/{experimentId}/
  const { data: subjectFolders, error: listErr } = await admin.storage
    .from("experiment-data")
    .list(experimentId, { limit: 1000 });
  if (listErr) {
    return NextResponse.json(
      { error: "List failed", detail: listErr.message },
      { status: 500 },
    );
  }

  const files: Array<{
    path: string;
    size_bytes: number | null;
    last_modified: string | null;
  }> = [];
  for (const folder of subjectFolders ?? []) {
    if (!folder.name) continue;
    const { data: blockFiles } = await admin.storage
      .from("experiment-data")
      .list(`${experimentId}/${folder.name}`, { limit: 1000 });
    for (const f of blockFiles ?? []) {
      if (!f.name.endsWith(".json")) continue;
      files.push({
        path: `${experimentId}/${folder.name}/${f.name}`,
        size_bytes:
          typeof f.metadata?.size === "number" ? f.metadata.size : null,
        last_modified: f.updated_at ?? null,
      });
    }
  }

  // Batch-create 15-minute signed URLs. Supabase SDK supports createSignedUrls.
  let signedMap: Record<string, string> = {};
  if (files.length > 0) {
    const { data: signed, error: signErr } = await admin.storage
      .from("experiment-data")
      .createSignedUrls(
        files.map((f) => f.path),
        60 * 15,
      );
    if (signErr) {
      return NextResponse.json(
        { error: "Sign failed", detail: signErr.message },
        { status: 500 },
      );
    }
    signedMap = Object.fromEntries(
      (signed ?? []).map((s) => [s.path ?? "", s.signedUrl]),
    );
  }

  return NextResponse.json({
    files: files.map((f) => ({
      ...f,
      signed_url: signedMap[f.path] ?? null,
    })),
  });
}
