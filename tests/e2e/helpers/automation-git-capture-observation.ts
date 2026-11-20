import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { browser } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../../src/shared/safe-json.ts'
import { e2eWorkspaceDir } from './seed-config.ts'
import { E2E_SCREENSHOT_DIR } from './screenshot.ts'

interface CaptureThreadRef {
  projectId: string
  threadId: string
}

type CaptureSpec =
  | 'tests/e2e/mcp-project-navigation.e2e.ts'
  | 'tests/e2e/automation-headless-tools.e2e.ts'

const threadRefSchema = z.object({
  projectId: z.string().regex(/^[\w-]{1,128}$/),
  threadId: z.string().regex(/^[\w-]{1,128}$/),
})
const metadataSchema = z.object({
  id: z.string(),
  status: z.string(),
  gitBranch: z.string().optional(),
  worktree: z
    .object({
      path: z.string(),
      branch: z.string(),
      retiredAt: z.number().optional(),
    })
    .optional(),
})

function limitedOutput(
  value: string | null,
  limit: number,
): { text: string; available: boolean; truncated: boolean } {
  const text = value ?? ''
  return { text: text.slice(0, limit), available: value !== null, truncated: text.length > limit }
}

function inspectManagedGit(ref: CaptureThreadRef): Record<string, unknown> {
  try {
    if (!threadRefSchema.safeParse(ref).success) return { ...ref, state: 'invalid-thread-ref' }
    const workspace = e2eWorkspaceDir()
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    if (!worktrees || resolve(worktrees) !== resolve(dirname(workspace), 'worktrees')) {
      return { ...ref, state: 'non-fixture-worktree-root' }
    }
    for (const path of [
      workspace,
      join(workspace, ref.projectId),
      join(workspace, ref.projectId, ref.threadId),
    ]) {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return { ...ref, state: 'non-managed-metadata-directory' }
    }
    const metadataPath = join(workspace, ref.projectId, ref.threadId, 'meta.json')
    const metadataStat = lstatSync(metadataPath)
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
      return { ...ref, state: 'non-regular-metadata' }
    }
    const meta = safeJsonParse(readFileSync(metadataPath, 'utf8'), decodeWithSchema(metadataSchema))
    if (!meta || meta.id !== ref.threadId) return { ...ref, state: 'invalid-metadata' }
    if (!meta.worktree) return { ...ref, state: 'no-managed-worktree', meta }
    if (meta.worktree.retiredAt !== undefined) return { ...ref, state: 'retired-worktree', meta }
    const expected = join(worktrees, ref.projectId, ref.threadId)
    if (meta.worktree.path !== expected) return { ...ref, state: 'non-managed-recorded-path', meta }
    for (const path of [worktrees, join(worktrees, ref.projectId), expected]) {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return { ...ref, state: 'non-managed-directory', meta }
    }
    const canonicalRoot = realpathSync(expected)
    if (relative(realpathSync(worktrees), canonicalRoot) !== join(ref.projectId, ref.threadId))
      return { ...ref, state: 'non-managed-canonical-path', meta }
    const inheritedGitOverrides = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ].filter((key) => process.env[key] !== undefined)
    if (inheritedGitOverrides.length > 0)
      return { ...ref, state: 'uninspected-git-context-override', inheritedGitOverrides, meta }
    const reads = [
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      ['remote'],
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      ['for-each-ref', '--format=%(refname)%09%(objectname)'],
    ].map((args) => {
      const startedAt = Date.now()
      const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd: canonicalRoot,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1_000_000,
      })
      const stdout = limitedOutput(result.stdout, 8_000)
      const stderr = limitedOutput(result.stderr, 2_000)
      return {
        args,
        startedAt,
        completedAt: Date.now(),
        status: result.status,
        signal: result.signal,
        error: result.error === undefined ? null : String(result.error),
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutAvailable: stdout.available,
        stderrAvailable: stderr.available,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      }
    })
    return {
      ...ref,
      state: 'inspected-managed-worktree',
      meta,
      canonicalRoot,
      allReadsSucceeded: reads.every((read) => read.status === 0 && read.error === null),
      reads,
    }
  } catch (error) {
    return { ...ref, state: 'inspection-unavailable', error: String(error) }
  }
}

async function readRows(refs: CaptureThreadRef[]): Promise<Record<string, unknown>> {
  return browser.execute(async (targets) => {
    const rows = targets.map((ref) => {
      const row = document.querySelector(`.chat-row[data-thread-id="${CSS.escape(ref.threadId)}"]`)
      const glyph = row?.querySelector('.chat-changes-status')
      return {
        ...ref,
        connected: row?.isConnected ?? false,
        title: row?.querySelector('.chat-title')?.textContent ?? null,
        classes: row?.className ?? null,
        changesAriaLabel: glyph?.getAttribute('aria-label') ?? null,
        changesTooltip: glyph?.getAttribute('data-tooltip') ?? null,
      }
    })
    return {
      at: Date.now(),
      navigation: await window.api.windowState.getNavigation(),
      workspace: await window.api.workspace.get(),
      rows,
    }
  }, refs)
}

/**
 * Read-only capture evidence, not a readiness condition. These calls add latency
 * and may populate the existing summary cache; a nonreproduction is not a fix.
 * Keep each bounded record on stdout so successful Linux jobs retain the proof.
 */
export async function observeAutomationGitCapture(
  phase: 'before-capture' | 'after-capture',
  screenshot: string,
  spec: CaptureSpec,
  refs: CaptureThreadRef[],
): Promise<void> {
  const startedAt = Date.now()
  const beforeRead = await readRows(refs)
  const summaries = await browser.execute(
    (targets) => window.api.git.threadChangeSummary(targets, { fresh: true }),
    refs,
  )
  const managedGit = refs.map(inspectManagedGit)
  const afterRead = await readRows(refs)
  const image =
    phase === 'after-capture' ? readFileSync(join(E2E_SCREENSHOT_DIR, screenshot)) : undefined
  console.info(
    '[automation-git-capture-observation]',
    JSON.stringify({
      phase,
      screenshot,
      spec,
      specSha256: createHash('sha256')
        .update(readFileSync(join(process.cwd(), spec)))
        .digest('hex'),
      helperSha256: createHash('sha256')
        .update(
          readFileSync(
            join(process.cwd(), 'tests/e2e/helpers/automation-git-capture-observation.ts'),
          ),
        )
        .digest('hex'),
      startedAt,
      completedAt: Date.now(),
      beforeRead,
      summaries,
      managedGit,
      afterRead,
      imageSha256: image ? createHash('sha256').update(image).digest('hex') : null,
      imageBytes: image?.length ?? null,
    }),
  )
}
