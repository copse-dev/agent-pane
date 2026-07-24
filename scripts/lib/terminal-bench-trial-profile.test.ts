import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { terminalBenchProfile } from './terminal-bench-profiles.mts'
import {
  readTerminalBenchTrialProfile,
  recordTerminalBenchTrialProfile,
} from './terminal-bench-trial-profile.mts'

const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function resultPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copse-terminal-profile-'))
  roots.push(root)
  const trial = join(root, 'trial')
  await mkdir(trial)
  return join(trial, 'result.json')
}

describe('Terminal-Bench retained profile metadata', () => {
  it('records the current product profile as v3', async () => {
    const result = await resultPath()
    await recordTerminalBenchTrialProfile(result, 'product-aligned')
    const retained = await readTerminalBenchTrialProfile(result)
    assert.equal(retained?.versionedId, 'product-aligned@3')
  })

  it('continues loading historical product-aligned v2 capsules', async () => {
    const result = await resultPath()
    const v2 = terminalBenchProfile('product-aligned@2')
    await writeFile(
      join(result, '..', 'terminal-bench-profile.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        profile: v2.versionedId,
        contentHash: v2.contentHash,
      })}\n`,
    )
    const retained = await readTerminalBenchTrialProfile(result)
    assert.equal(retained?.versionedId, 'product-aligned@2')
    assert.equal(retained.contentHash, v2.contentHash)
  })

  it('continues loading historical product-aligned v1 capsules', async () => {
    const result = await resultPath()
    const legacy = terminalBenchProfile('product-aligned@1')
    await writeFile(
      join(result, '..', 'terminal-bench-profile.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        profile: legacy.versionedId,
        contentHash: legacy.contentHash,
      })}\n`,
    )
    const retained = await readTerminalBenchTrialProfile(result)
    assert.ok(retained)
    assert.equal(retained.versionedId, 'product-aligned@1')
    assert.equal(retained.contentHash, legacy.contentHash)
  })

  it('does not silently accept a v1 hash under the v2 identity', async () => {
    const result = await resultPath()
    const legacy = terminalBenchProfile('product-aligned@1')
    await writeFile(
      join(result, '..', 'terminal-bench-profile.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        profile: 'product-aligned@2',
        contentHash: legacy.contentHash,
      })}\n`,
    )
    await assert.rejects(readTerminalBenchTrialProfile(result), /Inconsistent retained/)
  })

  it('writes parseable JSON metadata', async () => {
    const result = await resultPath()
    await recordTerminalBenchTrialProfile(result, 'main-legacy')
    const raw: unknown = JSON.parse(
      await readFile(join(result, '..', 'terminal-bench-profile.json'), 'utf8'),
    )
    assert.equal(typeof raw, 'object')
  })
})
