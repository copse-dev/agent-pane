import { z } from 'zod'
import { defineTool } from '@shared/types'
import { SUPPORTED_ARCHIVE_EXTENSIONS, MAX_ARCHIVE_BYTES } from '@shared/archive/archive-media.ts'
import { fileExtension, formatByteSize } from '@shared/file-bytes.ts'
import { resolveReadablePathWithinRoot } from '../services/workspace.ts'
import { requireAgentExecutionRoot } from '../services/execution-root.ts'
import { requireThreadExecutionOwner } from '../services/thread-execution-context.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'
import {
  extractArchiveForThread,
  type ExtractedArchive,
} from '../services/archive/archive-extract.ts'

/**
 * Turn an attached zip into a directory of ordinary files.
 *
 * The alternative designs are worse in the same way: a tool that returns one
 * entry's contents at a time makes the model page through an archive it cannot
 * see the shape of, and a tool that dumps every file into the result spends a
 * context window on a tree the model mostly does not need. Unpacking once and
 * handing back a *listing* lets the model do what it is already good at — pick
 * the files that matter and read them with `read_file` / `search_code` /
 * `explore` — because after this call the archive is just a folder.
 */

/**
 * Entries listed inline in the result.
 *
 * The listing is the whole value of the call, so it should be generous; but an
 * archive of ten thousand files would be a context window of filenames. Past
 * this the result says how many were withheld and points at `list_dir`, which
 * can walk the rest at the model's own pace.
 */
const MAX_LISTED_ENTRIES = 200

function describeSupportedFormats(): string {
  return SUPPORTED_ARCHIVE_EXTENSIONS.join(', ')
}

/** The manifest body: one line per file, with sizes so the model can triage. */
function listingLines(extracted: ExtractedArchive): string[] {
  return extracted.files
    .slice(0, MAX_LISTED_ENTRIES)
    .map((file) => `  ${file.path}  (${formatByteSize(file.sizeBytes)})`)
}

export const readArchiveTool = defineTool({
  name: 'read_archive',
  description:
    "Unpack a zip archive so you can read what is inside it with your normal file tools. The archive is extracted into this conversation's own directory and the result lists every file it contained, with sizes. From then on those are ordinary files: read one with `read_file`, grep them with `search_code`, walk them with `list_dir`, or summarize the whole tree with `explore` — using the absolute paths under the extraction root this returns. Extracting the same archive twice reuses the first extraction rather than doing the work again, so re-calling it in a later turn is cheap. Directory entries, symlinks, and any entry whose path tries to escape the archive root are skipped and reported.",
  parameters: z.object({
    path: z
      .string()
      .describe(
        `Path to the archive: the absolute path given for an archive the user attached to the chat, or a workspace-relative path. Supported: ${describeSupportedFormats()}.`,
      ),
  }),
  async execute({ path }, signal) {
    const extension = fileExtension(path)
    if (!(SUPPORTED_ARCHIVE_EXTENSIONS as readonly string[]).includes(extension)) {
      return `${path} is not a supported archive (${describeSupportedFormats()}).`
    }

    const root = requireAgentExecutionRoot()
    let absPath: string
    try {
      absPath = await resolveReadablePathWithinRoot(path, root)
    } catch (err) {
      return err instanceof Error ? err.message : `Could not resolve ${path}.`
    }

    let bytes: Buffer
    try {
      bytes = await getActiveWorkspaceFs().readFileBytes(absPath)
    } catch {
      return `Could not read archive: ${path}`
    }
    if (bytes.byteLength === 0) return `${path} is empty.`
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      return `${path} is ${formatByteSize(bytes.byteLength)}, over the ${formatByteSize(MAX_ARCHIVE_BYTES)} limit for archive extraction.`
    }

    const owner = requireThreadExecutionOwner()
    let extracted: ExtractedArchive
    try {
      extracted = await extractArchiveForThread({
        projectId: owner.projectId,
        threadId: owner.threadId,
        name: path,
        bytes: new Uint8Array(bytes),
        signal,
      })
    } catch (err) {
      return `Could not extract ${path}: ${err instanceof Error ? err.message : String(err)}`
    }

    if (extracted.files.length === 0) {
      const why =
        extracted.skipped.length > 0
          ? ` Every entry was skipped: ${extracted.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}.`
          : ''
      return `${path} contained no files.${why}`
    }

    const header = [
      `${path} — ${String(extracted.files.length)} file${extracted.files.length === 1 ? '' : 's'}${extracted.reused ? ', already extracted' : ' extracted'} to ${extracted.root}`,
      // Said explicitly because the natural next move is otherwise to call this
      // tool again for each file, when the files are already just files.
      'These are now ordinary files on disk. Read them with read_file, search_code, list_dir or explore, joining the paths below to the extraction root above. Do not call read_archive again for individual entries.',
    ]
    if (extracted.skipped.length > 0) {
      header.push(
        `Skipped ${String(extracted.skipped.length)} entr${extracted.skipped.length === 1 ? 'y' : 'ies'}: ${extracted.skipped
          .slice(0, 10)
          .map((s) => `${s.path} (${s.reason})`)
          .join(', ')}.`,
      )
    }
    if (extracted.truncated) {
      header.push(
        'The archive was larger than the extraction limits allow, so this is only part of it. What is listed below is complete and readable; the rest was not written.',
      )
    }
    const withheld = extracted.files.length - MAX_LISTED_ENTRIES
    if (withheld > 0) {
      header.push(
        `Listing the first ${String(MAX_LISTED_ENTRIES)} files; ${String(withheld)} more were extracted but are not listed here — use list_dir on the extraction root to see them.`,
      )
    }
    header.push('Contents:')

    return [...header, ...listingLines(extracted)].join('\n')
  },
})
