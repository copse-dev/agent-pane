import type { ReadTextFileRequest, ReadTextFileResponse } from '@agentclientprotocol/sdk/unstable'
import { z } from 'zod'
import { externalToolRead } from '../security/external-tool-read.ts'
import { ensureToolPermitted, type PermissionCheck } from '../security/permission-gate.ts'
import { toolPermissionDeniedMessage } from '../security/permission-policy.ts'
import { resolveReadablePathWithinRoot } from '../workspace.ts'
import { getActiveWorkspaceFs } from '../workspace-fs/get-workspace-fs.ts'

const pathArgs = z.object({ path: z.string().min(1) })

/** ACP returns raw text; native pagination footers must never enter file contents. */
export function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  if ((line === undefined || line === null) && (limit === undefined || limit === null))
    return content
  const lines = content.split('\n')
  const start = line && line > 0 ? line - 1 : 0
  const end = limit && limit > 0 ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}

/** Inject only the scoped worker boundary; the native gate and path checks always run. */
export function createAcpFileReader(readExternal: typeof externalToolRead) {
  return async (
    req: ReadTextFileRequest,
    root: string,
    signal?: AbortSignal,
  ): Promise<ReadTextFileResponse> => {
    signal?.throwIfAborted()
    const check: PermissionCheck = { toolName: 'read_file', args: { path: req.path } }
    if (!(await ensureToolPermitted(check, signal))) {
      signal?.throwIfAborted()
      throw new Error(toolPermissionDeniedMessage('read_file', check.denial))
    }
    // Hooks can rewrite a path. Authorize and read that same effective path.
    const { path } = pathArgs.parse(check.args)
    signal?.throwIfAborted()
    const external = await readExternal(path, root, 'read_file', { kind: 'read' }, signal)
    const content =
      external ??
      (await getActiveWorkspaceFs().readFile(
        await resolveReadablePathWithinRoot(path, root),
        'utf-8',
      ))
    signal?.throwIfAborted()
    return { content: sliceLines(content, req.line, req.limit) }
  }
}

export const readAcpTextFile = createAcpFileReader(externalToolRead)
