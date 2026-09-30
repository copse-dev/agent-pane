import { z } from 'zod'
import { defineTool } from '@shared/types'
import { errorMessage } from '@shared/errors.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { isRasterImagePath } from '@shared/fs/image-path.ts'
import { computeLineDiffStats } from '@shared/diff/line-stats.ts'
import { parsePatch, planPatch } from '@shared/patch/apply-patch.ts'
import { assertWriteTargetWithinRoot, resolvePathWithinRoot } from '../services/workspace.ts'
import { requireAgentExecutionRoot } from '../services/execution-root.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'
import {
  applyOrStageDiff,
  applyOrStageFileOp,
  getPendingAfterContent,
  getStagedDiffEntry,
} from '../services/diff-queue.ts'
import { detectLanguage } from '../services/language.ts'
import { readWorkspaceFileContent } from '../services/workspace-fs/file-content.ts'

export const APPLY_PATCH_DESCRIPTION = `Edit one or more files with a single patch. Prefer this over str_replace when a change spans several files or several places in one file; use str_replace for one small edit.

The \`input\` is a patch envelope:

*** Begin Patch
*** Update File: src/app.ts
@@ function start()
 context line kept as is
-line to remove
+line to add
 context line kept as is
*** Add File: src/new.ts
+every line of a new file starts with +
*** Delete File: src/old.ts
*** End Patch

Rules:
- Paths are relative to the workspace root. Never use absolute paths.
- "*** Update File: <path>" is followed by one or more hunks. Optionally add "*** Move to: <new path>" right after it to rename the file too.
- Start a hunk with "@@", optionally followed by a line (a function or class signature) that locates it. Repeat "@@ <line>" to narrow further. Hunks must be in file order.
- Every hunk line starts with " " (context, kept), "-" (removed) or "+" (added). Include about 3 lines of context above and below each change so it can be located; copy them exactly from read_file.
- "*** Add File" fails if the file exists; "*** Update File" and "*** Delete File" fail if it does not.
- The whole patch is validated before anything is written: if any hunk does not match, no file is changed and the error names the hunk. Edits then follow the same approval rules as str_replace and write_file.`

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err['code'] === 'ENOENT'
}

/** First sentence of a diff-queue result, which carries the outcome; the rest is boilerplate for one file. */
function outcomeOf(result: string): string {
  return result.split('\n')[0] ?? result
}

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description: APPLY_PATCH_DESCRIPTION,
  parameters: z.object({
    input: z
      .string()
      .describe('The full patch text, from "*** Begin Patch" through "*** End Patch"'),
  }),
  async execute({ input }) {
    const parsed = parsePatch(input)
    if (!parsed.ok) return `apply_patch rejected the patch; no files were changed. ${parsed.error}`

    const root = requireAgentExecutionRoot()
    const fs = getActiveWorkspaceFs()

    // Every path in the patch is a write target, so every path is resolved
    // against the trusted execution root before anything is read or written.
    const declared = parsed.hunks.flatMap((hunk) =>
      hunk.kind === 'update' && hunk.movePath !== null ? [hunk.path, hunk.movePath] : [hunk.path],
    )
    for (const path of declared) {
      try {
        if (isRasterImagePath(path)) {
          return `apply_patch cannot edit ${path}: binary images are not text. No files were changed.`
        }
        await assertWriteTargetWithinRoot(await resolvePathWithinRoot(path, root), root)
      } catch (err) {
        return `apply_patch rejected ${path}: ${errorMessage(err)} No files were changed.`
      }
    }

    // Compose onto pending staged content the way str_replace does, so a patch
    // sees the file as the user will see it after approving earlier edits.
    const plan = await planPatch(parsed.hunks, async (path) => {
      if (getStagedDiffEntry(path)?.op === 'delete') return null
      const pending = getPendingAfterContent(path)
      if (pending !== null) return pending
      try {
        return await readWorkspaceFileContent(fs, await resolvePathWithinRoot(path, root), path)
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    })
    if (!plan.ok) return `apply_patch failed; no files were changed. ${plan.error}`

    // Writes before deletes: if something fails midway, a moved file's content
    // exists at its destination before the source is removed.
    const ordered = [
      ...plan.changes.filter((change) => change.after !== null),
      ...plan.changes.filter((change) => change.after === null),
    ]
    const applied: string[] = []
    let additions = 0
    let deletions = 0
    for (const change of ordered) {
      const before = change.before ?? ''
      const after = change.after ?? ''
      const stats = computeLineDiffStats(before, after)
      const result =
        change.after === null
          ? await applyOrStageFileOp({
              op: 'delete',
              path: change.path,
              before,
              after: '',
              language: detectLanguage(change.path),
            })
          : await applyOrStageDiff(change.path, before, after, detectLanguage(change.path))
      if (result.startsWith('Failed to')) {
        const remaining = ordered.slice(applied.length + 1).map((c) => c.path)
        return {
          result: [
            `apply_patch stopped at ${change.path}: ${result}`,
            applied.length > 0
              ? `Already handled before the failure:\n${applied.join('\n')}`
              : 'No earlier file was changed.',
            remaining.length > 0
              ? `Not attempted: ${remaining.join(', ')}. Re-check with git_status and read_file, then send a new patch for the rest.`
              : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
          editStats: { additions, deletions },
        }
      }
      additions += stats.additions
      deletions += stats.deletions
      applied.push(`- ${outcomeOf(result)}`)
    }

    const paths = plan.changes
    return {
      result: `apply_patch handled ${String(paths.length)} file${paths.length === 1 ? '' : 's'}:\n${applied.join('\n')}`,
      editStats: { additions, deletions },
    }
  },
})
