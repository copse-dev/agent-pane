import { constants } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import type { Usage } from '@agentclientprotocol/sdk/unstable'
import type { StreamChunk } from '@shared/types'
import type { GeneratedImage, ImageGenerationRequest } from '../../tools/image-gen-tool.ts'
import {
  openAcpSession,
  runAcpSessionPrompt,
  type AcpTransportFactory,
  type MutableAcpHandlers,
  type AcpClientHandlers,
  type AcpAgentSpawnConfig,
} from './acp-client.ts'
import { buildAcpAdvisorSpawnConfig } from './acp-advisor.ts'
import { acpTurnUsage, permissionResponseFor } from './acp-agent-service.ts'
import { presentPermissionRequest } from './acp-approval-presentation.ts'
import { gateRemoteAcpEnvForward } from './acp-remote-env-gate.ts'
import { DeferredApprovalError } from '@shared/threads/deferred-approval.ts'
import { requestApproval, ApprovalPendingError } from '../approval.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { getActiveRunThread } from '../active-run-identity.ts'
import { currentRunIsUnattendedContainer } from '../security/unattended-run.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { addSubagentUsage } from '../subagent-usage.ts'
import { acpModelValue } from '@shared/acp.ts'

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** A user's refusal stops the whole route chain, including the paid fallback. */
export class ImageGenerationDeclinedError extends Error {}

function pngImage(base64: string): GeneratedImage {
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    throw new Error('Generated image exceeds 30 MB.')
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error('The agent did not return a PNG image.')
  return { base64: bytes.toString('base64') }
}

/** One-shot session: no native MCP bridge, no recursion, no coding-session history. */
export async function runAcpImageSession(
  config: AcpAgentSpawnConfig,
  agent: AcpAgentConfig,
  prompt: string,
  signal: AbortSignal,
  createTransport?: AcpTransportFactory,
): Promise<{ image: GeneratedImage | null; report: string }> {
  const permissions = new AbortController()
  let text = ''
  let base64: string | undefined
  let declined = false
  const wasDeclined = (): boolean => declined
  const approvalErrors: unknown[] = []
  const checkPermissions = (): void => {
    if (approvalErrors.length > 0) {
      const cause = approvalErrors[0]
      if (cause instanceof DeferredApprovalError || cause instanceof ApprovalPendingError)
        throw cause
      throw new ImageGenerationDeclinedError('Image runner permission could not be resolved.', {
        cause,
      })
    }
    if (wasDeclined())
      throw new ImageGenerationDeclinedError(
        'The user declined an image runner permission request.',
      )
  }
  let usage: Usage | null | undefined
  const collect = (chunk: StreamChunk): void => {
    if (chunk.type === 'text') text += chunk.text
    if (
      chunk.type === 'acp_content' &&
      chunk.channel === 'message' &&
      chunk.content.type === 'text'
    )
      text += chunk.content.text
    // Final image content and native generation tool output are both used by ACP adapters.
    const urls =
      chunk.type === 'acp_content' && chunk.channel === 'message' && chunk.content.type === 'image'
        ? [chunk.content.dataUrl]
        : chunk.type === 'tool_call_update' || chunk.type === 'tool_result'
          ? (chunk.images ?? []).map((image) => image.dataUrl)
          : []
    for (const url of urls) {
      if (url.startsWith('data:image/png;base64,'))
        base64 = url.slice('data:image/png;base64,'.length)
    }
  }
  const handlers: MutableAcpHandlers = {
    current: {
      onChunk: collect,
      // Protocol callbacks may run on a transport-created async resource. Keep
      // the invoking turn's approval handler, owner and execution-root scopes.
      requestPermission: AsyncLocalStorage.bind<AcpClientHandlers['requestPermission']>(
        async (req, rpcSignal) => {
          const decision = await requestApproval(
            {
              ...presentPermissionRequest(agent.title, req),
              cause: 'acp-permission',
              allowRemember: false,
            },
            AbortSignal.any([signal, rpcSignal, permissions.signal]),
          ).catch((error: unknown) => {
            approvalErrors.push(error)
            throw error
          })
          if (!decision.approved) {
            if (decision.resolution !== undefined && decision.resolution !== 'user') {
              approvalErrors.push(
                new Error(`Image runner permission was not approved (${decision.resolution}).`),
              )
            } else declined = true
          }
          return permissionResponseFor(req.options, decision.approved)
        },
      ),
    },
  }
  const session = await openAcpSession(config, handlers, createTransport, undefined, null, signal)
  try {
    const stop = await runAcpSessionPrompt(session, prompt, agent.model, signal)
    usage = stop.usage
    signal.throwIfAborted()
    checkPermissions()
    if (stop.stopReason === 'refusal')
      throw new ImageGenerationDeclinedError('Image runner refused this request.')
    if (stop.stopReason === 'cancelled')
      throw new ImageGenerationDeclinedError('Image runner cancelled.')
    if (stop.stopReason !== 'end_turn') throw new Error(`Image runner stopped: ${stop.stopReason}`)
    return { image: base64 ? pngImage(base64) : null, report: text }
  } catch (error) {
    checkPermissions()
    throw error
  } finally {
    permissions.abort()
    addSubagentUsage(acpModelValue(agent.id, agent.model), acpTurnUsage(usage, prompt, text))
    await session.dispose()
  }
}

export async function runAcpImageGeneration(
  agent: AcpAgentConfig,
  request: ImageGenerationRequest,
  signal: AbortSignal,
  createTransport?: AcpTransportFactory,
): Promise<GeneratedImage> {
  signal.throwIfAborted()
  if (currentRunIsUnattendedContainer(getActiveRunThread()))
    throw new Error('Local image runners are unavailable to unattended container turns.')
  if (isActiveSshWorkspace())
    throw new Error('Local image runners are unavailable in SSH workspaces.')
  const cwd = getAgentExecutionRoot()
  if (!cwd) throw new Error('Open a local workspace before using an image runner.')
  const scratchRoot = join(cwd, '.tmp')
  await mkdir(scratchRoot, { recursive: true })
  const root = await realpath(cwd)
  const scratch = await realpath(scratchRoot)
  const rel = relative(root, scratch)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Image scratch directory must remain inside the workspace.')
  const dir = await mkdtemp(join(scratch, 'image-gen-'))
  const output = join(dir, 'generated.png')
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
  try {
    // Generation needs no source checkout. Keep the runner's working directory
    // and its workspace sandbox rooted in the disposable artifact directory.
    const config = buildAcpAdvisorSpawnConfig(agent, dir)
    await gateRemoteAcpEnvForward(agent.id, config, deadline)
    const prompt = [
      'Generate exactly one PNG using your native image-generation tool. Use no Copse image_gen tool, API keys, shell-based drawing, SVG, browser screenshots or substitute artwork. If native generation is unavailable, say so and stop.',
      `Save the generated PNG to this exact path: ${output}. You may instead return the generated PNG as inline image content. Do not modify other workspace files.`,
      `Dimensions: ${request.size}; quality: ${request.quality}; background: ${request.background}.`,
      'Image description:',
      request.prompt,
    ].join('\n\n')
    const generated = await runAcpImageSession(config, agent, prompt, deadline, createTransport)
    if (generated.image) return generated.image
    const canonicalOutput = await realpath(output).catch((cause: unknown) => {
      throw new Error(
        `Image runner returned no generated PNG. ${generated.report.trim().slice(0, 1500)}`.trim(),
        { cause },
      )
    })
    if (canonicalOutput !== output)
      throw new Error('The image runner returned a symlink instead of a generated file.')
    const file = await open(
      output,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_IMAGE_BYTES)
        throw new Error('Image runner output must be a PNG file under 30 MB.')
      // Bound the read itself too: a helper must not grow the file after stat.
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length !== stat.size) throw new Error('Image runner output changed while being read.')
      return pngImage(bytes.subarray(0, length).toString('base64'))
    } finally {
      await file.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
