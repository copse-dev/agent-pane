import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parsePlanApproval,
  parsePlanCommentsFile,
  parsePlanMeta,
  parsePlanRevisionRecord,
  planApprovalPath,
  planBodyContentHash,
  planCommentsPath,
  planDir,
  planMetaPath,
  planRevisionPath,
  planArtifactRefs,
} from './plan-schema.ts'
import {
  SPINE_SCHEMA_VERSION,
  parseSpine,
  parseSpineLine,
  rebuildSpinePreservingNonMessageLines,
  serializeSpine,
  serializeSpineLine,
  type SpineMessageLine,
  type SpinePlanLine,
} from './spine-schema.ts'

const fix = join(process.cwd(), 'tests/fixtures/plan-mode')
const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fix, name), 'utf8'))
}

function messageLine(id: string): SpineMessageLine {
  return {
    v: SPINE_SCHEMA_VERSION,
    type: 'message',
    id,
    role: 'user',
    createdAt: 1,
    content: { ref: `messages/${id}.md`, sha256: 'abc' },
    toolCalls: [],
  }
}

describe('plan-schema paths', () => {
  it('keeps plan artifacts under plans/<planId>/', () => {
    assert.equal(planDir('p1'), 'plans/p1')
    assert.equal(planMetaPath('p1'), 'plans/p1/meta.json')
    assert.equal(planRevisionPath('p1', 2), 'plans/p1/revision-2.md')
    assert.equal(planCommentsPath('p1'), 'plans/p1/comments.json')
    assert.equal(planApprovalPath('p1'), 'plans/p1/approval.json')
  })
})

describe('plan-schema fixtures validate', () => {
  it('accepts draft meta + revision record + comments', () => {
    assert.ok(parsePlanMeta(readJson('meta-draft.json')))
    assert.ok(parsePlanRevisionRecord(readJson('revision-record-draft.json')))
    assert.ok(parsePlanCommentsFile(readJson('comments.json')))
  })

  it('rejects malformed comments (anchor end before start)', () => {
    const bad = {
      comments: [
        {
          id: 'c1',
          revision: 1,
          body: 'x',
          createdAt: 1,
          anchor: { start: 10, end: 2 },
        },
      ],
    }
    assert.equal(parsePlanCommentsFile(bad), null)
  })

  it('hashes revision markdown and validates approval records against it', () => {
    const body = readFileSync(join(fix, 'revision-1.md'), 'utf8')
    const contentHash = planBodyContentHash(body, hash)
    assert.equal(contentHash.length, 64)

    const approvalRaw = readJson('approval.json')
    assert.ok(approvalRaw && typeof approvalRaw === 'object')
    const approval = {
      ...approvalRaw,
      contentHash,
    }
    assert.ok(parsePlanApproval(approval))

    const metaRaw = readJson('meta-approved.json')
    assert.ok(metaRaw && typeof metaRaw === 'object')
    const meta = {
      ...metaRaw,
      contentHash,
    }
    assert.ok(parsePlanMeta(meta))
  })

  it('rejects approval without contentHash', () => {
    assert.equal(
      parsePlanApproval({
        planId: 'p',
        approvedRevision: 1,
        approvedAt: 1,
        executionProfileId: 'implementation',
      }),
      null,
    )
  })
})

describe('plan spine lifecycle lines', () => {
  it('round-trips fixture spine lines and stays invisible to parseSpine', () => {
    const raw = readFileSync(join(fix, 'spine-lines.jsonl'), 'utf8')
    const lines = raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => parseSpineLine(l))
    assert.equal(lines.length, 5)
    for (const line of lines) {
      assert.ok(line)
      assert.equal(line.type, 'plan')
      assert.deepEqual(parseSpineLine(serializeSpineLine(line)), line)
    }
    assert.equal(parseSpine(raw).length, 0)
  })

  it('rejects plan lines with unknown actions', () => {
    const bad = '{"v":1,"type":"plan","action":"teleport","id":"x","planId":"p","createdAt":1}'
    assert.equal(parseSpineLine(bad), null)
  })

  it('rejects plan lines missing required fields', () => {
    assert.equal(
      parseSpineLine('{"v":1,"type":"plan","action":"create","id":"x","createdAt":1}'),
      null,
    )
    assert.equal(
      parseSpineLine(
        '{"v":1,"type":"plan","action":"create","id":"x","planId":"p","createdAt":1,"artifact":{"ref":"plans/p/revision-1.md"}}',
      ),
      null,
    )
  })

  it('preserves plan artifact refs across full-save rebuild', () => {
    const m1 = messageLine('m1')
    const planLine: SpinePlanLine = {
      v: SPINE_SCHEMA_VERSION,
      type: 'plan',
      action: 'create',
      id: 'evt-1',
      planId: 'plan-auth-retry',
      revision: 1,
      createdAt: 10,
      artifact: { ref: 'plans/plan-auth-retry/revision-1.md', sha256: 'deadbeef' },
    }
    const existing = serializeSpine([m1, planLine])
    const { body, preservedRefs } = rebuildSpinePreservingNonMessageLines(existing, [m1])
    assert.ok(body.includes('"type":"plan"'))
    assert.deepEqual(preservedRefs, ['plans/plan-auth-retry/revision-1.md'])
    assert.deepEqual(planArtifactRefs(planLine.artifact), ['plans/plan-auth-retry/revision-1.md'])
  })
})
