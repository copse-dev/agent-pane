import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { postSummary, type PostedSummary } from '../src/pr-summary.ts'
import type { FetchLike, ForgeTarget } from '../src/forge-review.ts'
import { END_MARKER, START_MARKER, findBotBlock } from '../src/summary-block.ts'
import { actionPublishingFetch, decodeActionRequest } from './action-policy.mts'

type Request = ReturnType<typeof decodeActionRequest>
const MAX_BYTES = 64 * 1024
const sha = z.string().regex(/^[0-9a-f]{40}$/)
const requestSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pr: z.number().int().positive(),
    head: sha,
    base: sha,
  })
  .strict()
const artifactSchema = z
  .object({
    version: z.literal(1),
    request: requestSchema,
    block: z.string().min(1).max(MAX_BYTES),
  })
  .strict()

function validateBlock(block: string, request: Request): void {
  const lines = block.split('\n')
  const found = findBotBlock(lines)
  if (
    found?.start !== 0 ||
    found.end !== lines.length - 1 ||
    [START_MARKER, '---', '', '> [!NOTE]'].some((line, index) => lines[index] !== line) ||
    !/^> \*\*(Low|Medium|High) risk\*\*$/.test(lines[4] ?? '') ||
    lines.at(-4) !== '>' ||
    lines.at(-1) !== END_MARKER ||
    lines.length > 24 ||
    lines.some(
      (line) => /[\u0000-\u001f\u007f]/.test(line) || Buffer.byteLength(line, 'utf8') > 4096,
    )
  ) {
    throw new Error('Invalid rendered summary block')
  }
  const footer = lines.at(-3) ?? ''
  const prefix = `> <sup>Summary by Copse Reviewer for commit ${request.head.slice(0, 12)}.`
  if (
    !footer.startsWith(prefix) ||
    !/^(?: The review reported (?:no issues|[1-9][0-9]* issues?)\.)? copse-review [A-Za-z0-9._+-]{1,64}<\/sup>$/.test(
      footer.slice(prefix.length),
    )
  ) {
    throw new Error('Summary footer does not identify the reviewed head')
  }
  const points = lines.filter((line) => line.startsWith('> - '))
  if (points.length < 1 || points.length > 5) throw new Error('Invalid summary overview')
  for (const line of lines.slice(4, -4)) {
    if (line !== '>' && !line.startsWith('> ')) {
      throw new Error('Summary prose must stay inside the renderer blockquote')
    }
    // Match the renderer's self-contained code spans. HTML and mentions inside
    // those spans are inert; elsewhere the renderer always escapes them.
    const prose = line.replace(/(?<![\\`])(`+)(?!`)[^\r\n]*?(?<!`)\1(?!`)/g, '')
    if (/[<>]|@(?=[A-Za-z0-9])/.test(prose.replace(/^> ?/, ''))) {
      throw new Error('Summary prose is not inert renderer output')
    }
  }
}

/** Data only: no target URL, credential, filesystem path or executable payload. */
export function encodeSummaryArtifact(request: Request, block: string): string {
  const text = JSON.stringify({ version: 1, request, block }) + '\n'
  decodeSummaryArtifact(text, request)
  return text
}

export function decodeSummaryArtifact(text: string, trustedRequest: Request): { block: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Summary artifact is too large')
  const artifact = safeJsonParse(text, decodeWithSchema(artifactSchema))
  if (artifact === null) throw new Error('Invalid summary artifact')
  const trusted = requestSchema.parse(trustedRequest)
  if (
    artifact.request.repository !== trusted.repository ||
    artifact.request.pr !== trusted.pr ||
    artifact.request.head !== trusted.head ||
    artifact.request.base !== trusted.base
  ) {
    throw new Error('Summary artifact does not match the authorized request')
  }
  validateBlock(artifact.block, trusted)
  return { block: artifact.block }
}

/** Bind the downloaded file bytes to the trusted producer output before decoding. */
export function verifySummaryPayload(bytes: Uint8Array, expectedDigest: string): void {
  if (bytes.byteLength > MAX_BYTES) throw new Error('Summary artifact is too large')
  const digest = expectedDigest.replace(/^sha256:/, '')
  if (
    !/^[0-9a-f]{64}$/.test(digest) ||
    createHash('sha256').update(bytes).digest('hex') !== digest
  ) {
    throw new Error('Summary payload digest could not be verified')
  }
}

const metadataSchema = z.object({
  id: z.number().int().positive(),
  workflow_run: z.object({ id: z.number().int().positive() }),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  expired: z.literal(false),
  // One tiny JSON file, with a bounded allowance for ZIP framing.
  size_in_bytes: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTES + 4096)
    .optional(),
})

export function verifySummaryArtifactMetadata(
  metadataText: string,
  expected: { artifactId: string; runId: string; digest: string },
): void {
  const metadata = safeJsonParse(metadataText, decodeWithSchema(metadataSchema))
  const digest = expected.digest.startsWith('sha256:')
    ? expected.digest
    : `sha256:${expected.digest}`
  if (
    metadata === null ||
    !/^[1-9][0-9]*$/.test(expected.artifactId) ||
    !/^[1-9][0-9]*$/.test(expected.runId) ||
    !/^sha256:[0-9a-f]{64}$/.test(digest) ||
    String(metadata.id) !== expected.artifactId ||
    String(metadata.workflow_run.id) !== expected.runId ||
    metadata.digest !== digest
  ) {
    throw new Error('Summary artifact provenance could not be verified')
  }
}

/** Only the isolated, model-free publisher supplies this workflow write token. */
export async function publishSummaryArtifact(
  text: string,
  trustedRequest: Request,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<PostedSummary> {
  if (!token.trim()) throw new Error('Summary publication requires its workflow token')
  const { block } = decodeSummaryArtifact(text, trustedRequest)
  const [owner = '', repo = ''] = trustedRequest.repository.split('/')
  const target: ForgeTarget = {
    forge: 'github',
    apiBase: 'https://api.github.com',
    owner,
    repo,
    number: trustedRequest.pr,
    headCommit: trustedRequest.head,
    token,
  }
  return postSummary(target, block, {
    fetch: actionPublishingFetch(trustedRequest, token, fetchImpl),
  })
}
