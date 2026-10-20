import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { getActiveRunThread } from '../active-run-identity.ts'
import { getChatStoreRoot } from '../workspace.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { requestApproval } from '../approval.ts'
import { runCommand } from '../exec/command-runner.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/spawn.ts'
import {
  fsWorkerOneShotSandboxOverlay,
  readAllowedSandboxOverlay,
} from '../../project-sandbox/config.ts'
import {
  sandboxFsWorkerPath,
  SANDBOX_FS_REQUEST_ENV,
  SANDBOX_FS_WORKER_STDOUT_MAX_BYTES,
} from '../../project-sandbox/sandbox-fs-client.ts'
import {
  externalReadRequestSchema,
  type ExternalReadAction,
} from '../../project-sandbox/external-read-worker.ts'
import {
  analyzeReadOutsideProject,
  formatReadOutsideProjectPromptParts,
  READ_OUTSIDE_PROJECT_TITLE,
  sensitiveTargetReason,
} from './read-outside-project.ts'
import { grantReadOutsideProject, hasReadOutsideProjectGrant } from './read-outside-grant.ts'
import { shellPromptToApprovalFields } from './permission-policy.ts'
import { resolveToolPermission } from './tool-permissions.ts'
import { recordDecision } from './decision-log-store.ts'

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Return null for the existing workspace/chat-store route. External reads are
 * opt-in at read-tool entry points, never a relaxation of the general path
 * resolver used by writes, previews, remote backends, or app-owned operations.
 */
interface ExternalReadDependencies {
  run: typeof runCommand
  workerPath: () => string
  sandboxEnabled: () => boolean
}

async function readExternalTool(
  dependencies: ExternalReadDependencies,
  path: string,
  root: string,
  toolName: string,
  action: ExternalReadAction,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isAbsolute(path) || isActiveSshWorkspace()) return null
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    // Preserve the ordinary missing-file error and fail-closed resolver.
    return null
  }
  if (isPathInsideRoot(canonical, await realpath(root))) return null
  const chatRoot = await getChatStoreRoot()
  // Other-conversation access stays under its separate permission, including
  // aliases into the store. Never turn a declined conversation read into an
  // ordinary outside-path approval.
  if (chatRoot && isPathInsideRoot(canonical, chatRoot)) return null
  const thread = getActiveRunThread()
  if (!thread || !dependencies.sandboxEnabled())
    throw new Error('External file tools require an active thread and project sandbox.')
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
  const analysis = analyzeReadOutsideProject(`cat ${quote(canonical)}`, root)
  if (
    !analysis.eligible ||
    sensitiveTargetReason(path, path) ||
    sensitiveTargetReason(canonical, canonical) ||
    sensitiveTargetReason(path, `${path}${sep}`) ||
    sensitiveTargetReason(canonical, `${canonical}${sep}`)
  )
    throw new Error('External read target is too broad or contains credentials.')
  const before = await stat(canonical, { bigint: true })
  if (!before.isFile() && !before.isDirectory())
    throw new Error('External reads require a regular file or directory.')
  const policy = resolveToolPermission(toolName)?.policy
  if (policy === 'block') throw new Error('This tool is blocked.')
  let remember = false
  if (policy === 'ask' || !hasReadOutsideProjectGrant(thread, [canonical])) {
    const answer = await requestApproval(
      {
        type: 'mcp',
        title: READ_OUTSIDE_PROJECT_TITLE,
        ...shellPromptToApprovalFields(
          formatReadOutsideProjectPromptParts(`${toolName}: ${path}`, analysis),
        ),
        scope: 'external-read',
        subject: toolName,
        cause: 'mcp-tool',
        reasons: [canonical],
        collapseDetails: true,
        approveLabel: 'Allow reads for this chat',
        approveOnceLabel: 'Approve this read',
      },
      signal,
    )
    if (!answer.approved) throw new Error('External read access was declined.')
    remember = answer.remember
  }
  signal?.throwIfAborted()
  if (resolveToolPermission(toolName)?.policy === 'block') throw new Error('This tool is blocked.')
  const after = await stat(canonical, { bigint: true })
  if ((await realpath(path)) !== canonical || before.dev !== after.dev || before.ino !== after.ino)
    throw new Error(
      'External read target changed while permission was being checked. Retry the read.',
    )
  if (remember) grantReadOutsideProject(thread, [canonical])
  const workerPath = dependencies.workerPath()
  const worker = fsWorkerOneShotSandboxOverlay(root, workerPath, 'read')
  const grant = readAllowedSandboxOverlay(root, [canonical])
  if (!worker.filesystem || !grant.filesystem || !grant.network)
    throw new Error('Missing read sandbox configuration.')
  const request = externalReadRequestSchema.parse({
    op: 'externalRead',
    path: canonical,
    action,
    excludedRoots: chatRoot ? [chatRoot] : [],
  })
  const result = await dependencies.run(process.execPath, [workerPath], {
    cwd: root,
    ...(signal ? { signal } : {}),
    requireSandbox: true,
    timeout_ms: 10_000,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      [SANDBOX_FS_REQUEST_ENV]: JSON.stringify(request),
      ...(process.env['COPSE_DIR'] ? { COPSE_DIR: process.env['COPSE_DIR'] } : {}),
    },
    stdoutMaxBytes: SANDBOX_FS_WORKER_STDOUT_MAX_BYTES,
    sandboxConfig: {
      ...worker,
      network: grant.network,
      filesystem: {
        ...worker.filesystem,
        allowRead: [
          ...new Set([
            ...(worker.filesystem.allowRead ?? []),
            ...(grant.filesystem.allowRead ?? []),
          ]),
        ],
      },
    },
  })
  if (result.stdoutTruncated) throw new Error('External read exceeded the output limit.')
  const response = safeJsonParse(result.stdout, decodeWithSchema(responseSchema))
  if (!response || result.code !== 0 || !response.ok)
    throw new Error(response && !response.ok ? response.error : 'Sandboxed external read failed.')
  recordDecision({
    kind: 'tool',
    actor: 'user',
    verdict: 'allowed',
    subject: toolName,
    scope: 'external-read',
    reasons: [canonical],
    source: 'external-tool-read',
  })
  return response.data
}

/** Inject the process boundary for focused tests; production always uses ASRT. */
export function createExternalToolReader(
  dependencies: ExternalReadDependencies,
): (
  path: string,
  root: string,
  toolName: string,
  action: ExternalReadAction,
  signal?: AbortSignal,
) => Promise<string | null> {
  return (path, root, toolName, action, signal) =>
    readExternalTool(dependencies, path, root, toolName, action, signal)
}

export const externalToolRead = createExternalToolReader({
  run: runCommand,
  workerPath: sandboxFsWorkerPath,
  sandboxEnabled: isProjectSandboxEnabled,
})
