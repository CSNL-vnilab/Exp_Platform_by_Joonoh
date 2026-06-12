import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { listExperimentBlocks } from "@/lib/storage/experiment-blocks";

// GET /api/experiments/:experimentId/data-export
//
// Researcher-only endpoint that lists every JSON block uploaded for the
// experiment and returns short-lived signed URLs for download. Streams
// back as { files: [{ path, signed_url, size_bytes }...] } so the admin
// UI can render a download list or a researcher can pipe wget over the
// array.
//
// The traversal (multi-session `session_{N}/` sub-folders, optional `_pilot`)
// is shared with the CSV export via listExperimentBlocks so the two exports
// can't drift on storage-layout changes. Pass `?include_pilot=1` to include
// pilot runs.

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

  const includePilot =
    new URL(_request.url).searchParams.get("include_pilot") === "1";

  // Walk subject folders under experiment-data/{experimentId}/, descending
  // into multi-session `session_{N}/` sub-folders (and `_pilot` when
  // requested). Shared with the CSV export via listExperimentBlocks.
  const blockEntries = await listExperimentBlocks(admin, experimentId, {
    includePilot,
  });

  const files = blockEntries.map((b) => ({
    path: b.path,
    size_bytes: b.size_bytes,
    last_modified: b.last_modified,
  }));

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
