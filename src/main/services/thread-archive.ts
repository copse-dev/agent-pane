import { readThreadDirectory } from './thread-store.ts'
import { createZipArchive } from './storage/zip-archive.ts'

/**
 * "Export thread folder (ZIP)" — the whole on-disk thread directory, zipped.
 *
 * The JSONL export ([`export-jsonl.ts`](../../shared/threads/export-jsonl.ts))
 * stays the portable, self-contained transcript; this is the other half: a
 * faithful copy of `~/.copse/workspace/<projectId>/<threadId>/` including the
 * spine, OKF prose, blobs, plans, the provider-history sidecar, and nested
 * subagent directories. Entries are nested under a `<threadId>/` folder so the
 * archive extracts as the same directory it came from, rather than scattering
 * `meta.json` and friends into the user's Downloads.
 */
export async function buildThreadArchive(
  projectId: string,
  threadId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const files = await readThreadDirectory(projectId, threadId)
  return createZipArchive(
    files.map((file) => ({
      path: `${threadId}/${file.path}`,
      data: file.data,
      modifiedAt: file.modifiedAt,
    })),
  )
}
