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
  it('records the current product profile as v5', async () => {
    const result = await resultPath()
    await recordTerminalBenchTrialProfile(result, 'product-aligned')
    const retained = await readTerminalBenchTrialProfile(result)
    assert.equal(retained?.versionedId, 'product-aligned@5')
  })

  it('continues loading retired product-aligned v3 capsules', async () => {
    const result = await resultPath()
    const v3 = terminalBenchProfile('product-aligned@3')
    await writeFile(
      join(result, '..', 'terminal-bench-profile.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        profile: v3.versionedId,
        contentHash: v3.contentHash,
      })}\n`,
    )
    const retained = await readTerminalBenchTrialProfile(result)
    assert.equal(retained?.versionedId, 'product-aligned@3')
    assert.equal(retained.contentHash, v3.contentHash)
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

it('reads each archived v4 tuple without rewriting its retained sidecar', async () => {
  for (const contentHash of [
    '516606b6377201d949ad1d712056f68d6841f41a506499b0abbdfaf55dc8119c',
    '252de9d8b6a79e859f62bd2355edf71ccf76673f27628a7f25d3fdb7c6f0dc7d',
  ]) {
    const result = await resultPath()
    const sidecar = join(result, '..', 'terminal-bench-profile.json')
    const original =
      JSON.stringify({ schemaVersion: 1, profile: 'product-aligned@4', contentHash }) + '\n'
    await writeFile(sidecar, original)
    const retained = await readTerminalBenchTrialProfile(result)
    assert.equal(retained?.contentHash, contentHash)
    assert.notEqual(retained.retirement, null)
    assert.equal(await readFile(sidecar, 'utf8'), original)
  }
})
