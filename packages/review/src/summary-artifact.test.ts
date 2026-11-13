import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeSummaryArtifact,
  decodeSummaryArtifact,
  verifySummaryArtifactMetadata,
  publishSummaryArtifact,
  verifySummaryPayload,
  summaryFileIdentity,
} from '../ci/summary-artifact.mts'
import { actionPublishingFetch } from '../ci/action-policy.mts'
import { renderSummaryBlock } from './pr-summary.ts'
import { digestLine, bareLine } from './summary-block.ts'
import type { FetchLike } from './forge-review.ts'

const request = {
  repository: 'copse-dev/fixture',
  pr: 42,
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
}
const block = renderSummaryBlock(
  { risk: 'low', riskReason: 'A bounded helper change.', overview: ['Updates the helper safely.'] },
  { headCommit: request.head, toolVersion: '0.1.0', report: null },
)
const text = encodeSummaryArtifact(request, block)
const digest = 'c'.repeat(64)
const metadata = {
  id: 17,
  workflow_run: { id: 23 },
  digest: `sha256:${digest}`,
  expired: false,
  size_in_bytes: 2000,
}

function restamp(value: string): string {
  const lines = value.split('\n')
  lines[lines.length - 2] = digestLine(lines.slice(1, -2).map(bareLine))
  return lines.join('\n')
}

describe('summary file identity after review completion', () => {
  it('returns no identity for an absent file and hashes the exact validated file bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copse-summary-identity-'))
    try {
      const path = join(directory, 'summary.json')
      assert.equal(await summaryFileIdentity(path, request), null)
      await writeFile(path, text)
      const identity = await summaryFileIdentity(path, request)
      assert.equal(identity, createHash('sha256').update(text).digest('hex'))
      assert.equal(
        await summaryFileIdentity(join(directory, 'missing', 'summary.json'), request),
        null,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects symlinks, nonfiles and files larger than the byte boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copse-summary-identity-'))
    try {
      const path = join(directory, 'summary.json')
      await writeFile(path, text)
      const linked = join(directory, 'linked.json')
      await symlink(path, linked)
      await assert.rejects(summaryFileIdentity(linked, request), /regular file/)
      const nonfile = join(directory, 'not-a-file')
      await mkdir(nonfile)
      await assert.rejects(summaryFileIdentity(nonfile, request), /regular file/)
      await writeFile(path, Buffer.alloc(65537))
      await assert.rejects(summaryFileIdentity(path, request), /too large/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on malformed data, mismatched targets and non-ENOENT filesystem errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copse-summary-identity-'))
    try {
      const path = join(directory, 'summary.json')
      await writeFile(path, '{}')
      await assert.rejects(summaryFileIdentity(path, request), /Invalid summary artifact/)
      await writeFile(path, text)
      await assert.rejects(summaryFileIdentity(path, { ...request, pr: 43 }), /authorized request/)
      await assert.rejects(summaryFileIdentity(join(path, 'child.json'), request), {
        code: 'ENOTDIR',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('summary artifact boundary', () => {
  it('checks the exact downloaded payload bytes against a required producer SHA256', () => {
    const bytes = Buffer.from(text)
    const hash = createHash('sha256').update(bytes).digest('hex')
    verifySummaryPayload(bytes, hash)
    verifySummaryPayload(bytes, `sha256:${hash}`)
    for (const missingOrWrong of ['', 'not-a-digest', hash.toUpperCase(), 'f'.repeat(64)]) {
      assert.throws(() => {
        verifySummaryPayload(bytes, missingOrWrong)
      }, /digest/)
    }
    assert.throws(() => {
      verifySummaryPayload(Buffer.from(text + '\n'), hash)
    }, /digest/)
    assert.throws(() => {
      verifySummaryPayload(new Uint8Array(65537), hash)
    }, /too large/)
  })

  it('round trips renderer output, including inert HTML and mentions inside code', () => {
    assert.deepEqual(decodeSummaryArtifact(text, request), { block })
    const code = renderSummaryBlock(
      {
        risk: 'medium',
        riskReason: 'Handles `<div>@owner</div>` safely.',
        overview: ['Preserves inline code and @owner prose.'],
      },
      { headCommit: request.head, toolVersion: '1', report: null },
    )
    assert.deepEqual(decodeSummaryArtifact(encodeSummaryArtifact(request, code), request), {
      block: code,
    })
  })

  it('rejects other requests and arbitrary payload authority fields', () => {
    for (const patch of [
      { repository: 'other/repo' },
      { pr: 43 },
      { head: 'd'.repeat(40) },
      { base: 'e'.repeat(40) },
    ]) {
      assert.throws(
        () => decodeSummaryArtifact(text, { ...request, ...patch }),
        /authorized request/,
      )
    }
    for (const extra of [
      { token: 'app-token' },
      { url: 'https://evil.invalid' },
      { path: '../../summary' },
    ]) {
      assert.throws(
        () =>
          decodeSummaryArtifact(JSON.stringify({ version: 1, request, block, ...extra }), request),
        /Invalid summary artifact/,
      )
      assert.throws(
        () =>
          decodeSummaryArtifact(
            JSON.stringify({ version: 1, request: { ...request, ...extra }, block }),
            request,
          ),
        /Invalid summary artifact/,
      )
    }
    assert.throws(() =>
      decodeSummaryArtifact(JSON.stringify({ version: 2, request, block }), request),
    )
    assert.throws(() => decodeSummaryArtifact('{', request))
  })

  it('rejects oversized UTF8 data, incomplete shapes, wrong heads and forged active prose', () => {
    assert.throws(() => decodeSummaryArtifact('é'.repeat(33000), request), /too large/)
    for (const bad of [
      block + '\nExtra author text',
      block.replace('Updates', 'Changes'),
      restamp(block.replace(request.head.slice(0, 12), 'f'.repeat(12))),
      restamp(block.replace('A bounded helper change.', '<img src=x onerror=alert(1)>')),
      restamp(block.replace('Updates the helper safely.', '@owner inspect this now.')),
    ]) {
      assert.throws(() => encodeSummaryArtifact(request, bad))
    }
  })

  it('rejects tampered headers and unquoted HTML even with a recomputed valid digest', () => {
    const lines = block.split('\n')
    const mutations = [
      { index: 0, value: '<!-- copse-review-summary --> ' },
      { index: 1, value: '--- ' },
      { index: 2, value: '<img src=x onerror=alert(1)>' },
      { index: 3, value: '> [!NOTE]<script>alert(1)</script>' },
      { index: 4, value: '> **Unknown risk**' },
      { index: 5, value: '<img src=x onerror=alert(1)>' },
      { index: lines.length - 4, value: '<script>alert(1)</script>' },
    ]
    for (const mutation of mutations) {
      const tampered = [...lines]
      tampered[mutation.index] = mutation.value
      const stamped = restamp(tampered.join('\n'))
      assert.throws(
        () => encodeSummaryArtifact(request, stamped),
        /Invalid rendered summary block|blockquote/,
      )
    }
  })

  it('binds artifact ID, producing run and ZIP digest and rejects expiry or oversized archives', () => {
    const expected = { artifactId: '17', runId: '23', digest }
    verifySummaryArtifactMetadata(
      JSON.stringify({ ...metadata, name: 'extra API fields are allowed' }),
      expected,
    )
    verifySummaryArtifactMetadata(JSON.stringify(metadata), {
      ...expected,
      digest: `sha256:${digest}`,
    })
    for (const patch of [
      { id: 18 },
      { workflow_run: { id: 24 } },
      { digest: `sha256:${'d'.repeat(64)}` },
      { expired: true },
      { size_in_bytes: 70000 },
    ]) {
      assert.throws(() => {
        verifySummaryArtifactMetadata(JSON.stringify({ ...metadata, ...patch }), expected)
      }, /provenance/)
    }
    for (const patch of [{ artifactId: '017' }, { runId: '23junk' }, { digest: '' }]) {
      assert.throws(() => {
        verifySummaryArtifactMetadata(JSON.stringify(metadata), { ...expected, ...patch })
      }, /provenance/)
    }
    assert.throws(() => {
      verifySummaryArtifactMetadata('{}', expected)
    }, /provenance/)
  })
})

function forge(
  options: {
    initialHead?: string
    attestation?: Record<string, unknown>
    attestationStatus?: number
    patchStatus?: number
  } = {},
): {
  fetch: FetchLike
  calls: {
    url: string
    method: string
    authorization: string | undefined
    body: string | undefined
  }[]
} {
  const calls: {
    url: string
    method: string
    authorization: string | undefined
    body: string | undefined
  }[] = []
  let reads = 0
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      authorization: init.headers['Authorization'],
      body: init.body,
    })
    if (init.method !== 'GET') return { status: options.patchStatus ?? 200, text: async () => '{}' }
    reads += 1
    return {
      status: reads === 1 ? 200 : (options.attestationStatus ?? 200),
      text: async () =>
        JSON.stringify(
          reads === 1
            ? { body: 'Author text.', head: { sha: options.initialHead ?? request.head } }
            : {
                state: 'open',
                head: { sha: request.head },
                base: { sha: request.base },
                draft: false,
                labels: [],
                ...options.attestation,
              },
        ),
    }
  }
  return { calls, fetch }
}

describe('model-free summary publication', () => {
  it('uses only its explicit workflow token for reads, attestation and the exact body PATCH', async () => {
    const api = forge()
    assert.deepEqual(await publishSummaryArtifact(text, request, 'workflow-token', api.fetch), {
      updated: true,
    })
    assert.deepEqual(
      api.calls.map((c) => c.method),
      ['GET', 'GET', 'PATCH'],
    )
    assert.ok(api.calls.every((c) => c.authorization === 'Bearer workflow-token'))
    assert.ok(
      api.calls.every((c) => c.url === 'https://api.github.com/repos/copse-dev/fixture/pulls/42'),
    )
    assert.deepEqual(JSON.parse(api.calls.at(-1)?.body ?? ''), { body: `Author text.\n\n${block}` })
  })

  it('has no auth fallback and rejects malformed payloads before any request', async () => {
    const api = forge()
    for (const token of ['', '  '])
      await assert.rejects(
        publishSummaryArtifact(text, request, token, api.fetch),
        /workflow token/,
      )
    await assert.rejects(
      publishSummaryArtifact('{}', request, 'workflow-token', api.fetch),
      /Invalid summary artifact/,
    )
    assert.deepEqual(api.calls, [])
  })

  it('skips a head that moved before its initial read', async () => {
    const api = forge({ initialHead: 'f'.repeat(40) })
    const result = await publishSummaryArtifact(text, request, 'workflow-token', api.fetch)
    assert.equal(result.updated, false)
    assert.deepEqual(
      api.calls.map((c) => c.method),
      ['GET'],
    )
  })

  it('rechecks head, base, open state, draft consent and opt-out immediately before mutation', async () => {
    for (const attestation of [
      { head: { sha: 'f'.repeat(40) } },
      { base: { sha: 'f'.repeat(40) } },
      { state: 'closed' },
      { draft: true },
      { labels: [{ name: 'copse-review-skip' }] },
    ]) {
      const api = forge({ attestation })
      assert.equal(
        (await publishSummaryArtifact(text, request, 'workflow-token', api.fetch)).updated,
        false,
      )
      assert.deepEqual(
        api.calls.map((c) => c.method),
        ['GET', 'GET'],
      )
    }
    const consent = forge({ attestation: { draft: true, labels: [{ name: 'copse-review' }] } })
    assert.equal(
      (await publishSummaryArtifact(text, request, 'workflow-token', consent.fetch)).updated,
      true,
    )
  })

  it('fails closed when attestation or the actual PATCH fails', async () => {
    const denied = forge({ attestationStatus: 401 })
    await assert.rejects(
      publishSummaryArtifact(text, request, 'workflow-token', denied.fetch),
      /attest/,
    )
    assert.deepEqual(
      denied.calls.map((c) => c.method),
      ['GET', 'GET'],
    )
    const patch = forge({ patchStatus: 403 })
    await assert.rejects(
      publishSummaryArtifact(text, request, 'workflow-token', patch.fetch),
      /403/,
    )
  })

  it('leaves App credentials intact for review and feedback-label writes', async () => {
    const writes: string[] = []
    const fetch: FetchLike = async (_url, init) => {
      if (init.method === 'GET')
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              state: 'open',
              head: { sha: request.head },
              base: { sha: request.base },
              draft: false,
              labels: [],
            }),
        }
      writes.push(init.headers['Authorization'] ?? '')
      return { status: 200, text: async () => '{}' }
    }
    const publish = actionPublishingFetch(request, 'read-only-token', fetch)
    for (const url of [
      'https://api.github.com/repos/copse-dev/fixture/pulls/42/reviews',
      'https://api.github.com/repos/copse-dev/fixture/issues/42/labels',
    ]) {
      await publish(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer app-token' },
        body: '{}',
      })
    }
    assert.deepEqual(writes, ['Bearer app-token', 'Bearer app-token'])
  })
})
