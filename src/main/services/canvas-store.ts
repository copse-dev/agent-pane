/**
 * Durable record of the artefacts a thread has rendered on the canvas.
 *
 * Everything else about the canvas is in-memory: the Browser pane holds the
 * document in an opaque `data:` URL, the thumbnail lives in a renderer `Map`,
 * and the transcript keeps only the one-line `[ui resource: …]` summary that
 * `flattenMcpContent` writes. Quitting the app therefore threw the artefact
 * away — and with it the preview card that would have offered to reopen it, so
 * scrolling back to the turn that produced it showed a bare line of text.
 * Writing a copy beside the thread's transcript is what makes an artefact
 * outlive the window that rendered it.
 *
 * Files land in the thread's own directory, not the user's workspace: rendering
 * something on screen must not drop files into their repository. When the
 * artefact *was* rendered from a workspace file (`sourcePath`), reopening
 * prefers that file over the snapshot, so an artefact restored after a restart
 * reflects edits made to the source in between.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CanvasArtefact, CanvasArtefactSummary } from '@shared/types/canvas.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { projectStoreDir } from './storage/copse-paths.ts'
import { runSerialized } from './storage/write-queue.ts'
import { resolveWorkspacePath } from './workspace.ts'

const CANVAS_DIR = 'canvas'
const INDEX_FILE = 'index.json'
const INDEX_VERSION = 1

/**
 * How many artefacts a thread keeps. Re-rendering a title overwrites its record,
 * so this only bounds *distinct* titles — a thread that renamed its prototype
 * fifty times, not one that iterated on it fifty times.
 */
const MAX_STORED_ARTEFACTS = 50

/** How many thumbnails a transcript load reads back; the rest render cardless. */
const MAX_HYDRATED_PREVIEWS = 20

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/

const storedArtefactSchema = z.object({
  title: z.string(),
  mimeType: z.string(),
  bodyFile: z.string(),
  previewFile: z.string().optional(),
  /** Workspace-relative source, when the artefact was rendered from a file. */
  sourcePath: z.string().optional(),
  /**
   * Where `sourcePath` pointed when it was written. Reopening re-resolves the
   * relative path against the workspace that is open *now* and reads the file
   * only if the two agree — otherwise the same relative path in a different
   * project would silently render someone else's file.
   */
  sourceAbsPath: z.string().optional(),
  updatedAt: z.string(),
})

type StoredArtefact = z.infer<typeof storedArtefactSchema>

const indexSchema = z.object({
  version: z.number(),
  artefacts: z.array(storedArtefactSchema),
})

function canvasDir(projectId: string, threadId: string): string {
  return join(projectStoreDir(projectId), threadId, CANVAS_DIR)
}

/**
 * Stable, filesystem-safe base name for a title. The readable slug is for
 * whoever opens the directory; the hash suffix is what keeps two titles that
 * slug identically (`Sales report` and `sales-report`) in separate files.
 */
function artefactFileBase(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'artefact'
  const hash = createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

async function readIndex(projectId: string, threadId: string): Promise<StoredArtefact[]> {
  let raw: string
  try {
    raw = await readFile(join(canvasDir(projectId, threadId), INDEX_FILE), 'utf8')
  } catch {
    return []
  }
  return safeJsonParse(raw, decodeWithSchema(indexSchema))?.artefacts ?? []
}

async function writeIndex(
  projectId: string,
  threadId: string,
  artefacts: StoredArtefact[],
): Promise<void> {
  const dir = canvasDir(projectId, threadId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, INDEX_FILE),
    `${JSON.stringify({ version: INDEX_VERSION, artefacts }, null, 2)}\n`,
    'utf8',
  )
}

/** Absolute path of `sourcePath` in the workspace that is open now, if any. */
async function resolveSource(sourcePath: string | undefined): Promise<string | undefined> {
  if (!sourcePath) return undefined
  try {
    return await resolveWorkspacePath(sourcePath)
  } catch {
    return undefined
  }
}

/**
 * Save `artefact` under its thread, replacing any earlier version of the same
 * title — the tab shows the newest render, so the stored copy must too.
 *
 * Best-effort by design: failing to write the snapshot must not stop the
 * artefact reaching the canvas, so every caller treats a rejection as
 * "restoring it later won't work", not as a failed render.
 */
export async function rememberCanvasArtefact(
  projectId: string,
  threadId: string,
  artefact: CanvasArtefact,
): Promise<void> {
  const sourceAbsPath = await resolveSource(artefact.sourcePath)
  await runSerialized(`canvas-store:${projectId}:${threadId}`, async () => {
    const dir = canvasDir(projectId, threadId)
    await mkdir(dir, { recursive: true })

    const base = artefactFileBase(artefact.title)
    const bodyFile = `${base}${artefact.mimeType === 'text/html' ? '.html' : '.txt'}`
    await writeFile(join(dir, bodyFile), artefact.body, 'utf8')

    let previewFile: string | undefined
    const png = artefact.preview ? PNG_DATA_URL.exec(artefact.preview) : null
    if (png?.[1]) {
      previewFile = `${base}.png`
      await writeFile(join(dir, previewFile), Buffer.from(png[1], 'base64'))
    }

    const record: StoredArtefact = {
      title: artefact.title,
      mimeType: artefact.mimeType,
      bodyFile,
      ...(previewFile ? { previewFile } : {}),
      ...(artefact.sourcePath ? { sourcePath: artefact.sourcePath } : {}),
      ...(sourceAbsPath ? { sourceAbsPath } : {}),
      updatedAt: new Date().toISOString(),
    }

    // Newest last, so pruning takes from the front and hydration reads the tail.
    const kept = (await readIndex(projectId, threadId)).filter((a) => a.title !== artefact.title)
    kept.push(record)
    const pruned = kept.splice(0, Math.max(0, kept.length - MAX_STORED_ARTEFACTS))
    await writeIndex(projectId, threadId, kept)
    for (const stale of pruned) {
      await rm(join(dir, stale.bodyFile), { force: true })
      if (stale.previewFile) await rm(join(dir, stale.previewFile), { force: true })
    }
  })
}

/**
 * The saved artefacts a transcript needs to draw its preview cards. Bodies are
 * left on disk — a card shows a thumbnail and an Open button, and reading back
 * every artefact's HTML to render one would put the whole canvas history in the
 * renderer's heap on every thread switch.
 */
export async function loadCanvasArtefactSummaries(
  projectId: string,
  threadId: string,
): Promise<CanvasArtefactSummary[]> {
  const dir = canvasDir(projectId, threadId)
  const recent = (await readIndex(projectId, threadId)).slice(-MAX_HYDRATED_PREVIEWS)
  const out: CanvasArtefactSummary[] = []
  for (const record of recent) {
    let preview: string | undefined
    if (record.previewFile) {
      try {
        const png = await readFile(join(dir, record.previewFile))
        preview = `data:image/png;base64,${png.toString('base64')}`
      } catch {
        preview = undefined
      }
    }
    out.push({ title: record.title, ...(preview ? { preview } : {}) })
  }
  return out
}

/**
 * Read a saved artefact back so it can be rendered again, preferring the
 * workspace file it came from over the snapshot taken at render time. Returns
 * null when the thread never rendered that title, or when neither copy is
 * readable any more.
 */
export async function readStoredCanvasArtefact(
  projectId: string,
  threadId: string,
  title: string,
): Promise<CanvasArtefact | null> {
  const dir = canvasDir(projectId, threadId)
  const record = (await readIndex(projectId, threadId)).find((a) => a.title === title)
  if (!record) return null

  let body: string | null = null
  if (record.sourceAbsPath && (await resolveSource(record.sourcePath)) === record.sourceAbsPath) {
    body = await readFile(record.sourceAbsPath, 'utf8').catch(() => null)
  }
  body ??= await readFile(join(dir, record.bodyFile), 'utf8').catch(() => null)
  if (body === null) return null

  let preview: string | undefined
  if (record.previewFile) {
    const png = await readFile(join(dir, record.previewFile)).catch(() => null)
    if (png) preview = `data:image/png;base64,${png.toString('base64')}`
  }

  return {
    title: record.title,
    mimeType: record.mimeType,
    body,
    threadId,
    ...(preview ? { preview } : {}),
    ...(record.sourcePath ? { sourcePath: record.sourcePath } : {}),
  }
}
