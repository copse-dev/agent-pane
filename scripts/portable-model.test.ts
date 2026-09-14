import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// Stub the machine-information boundary; model selection uses the real manifest.
test('portable models adapt to machine memory, available files and explicit tier selection', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copse models with spaces ')))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const sysctl = join(bin, 'sysctl')
    const models = readFileSync(resolve('scripts/portable/models.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [repository, , filename] = line.split('\t')
        assert.ok(repository && filename)
        const folder = join(root, 'models', repository)
        mkdirSync(folder, { recursive: true })
        const path = join(folder, filename)
        writeFileSync(path, '')
        return path
      })
    const run = (memoryGiB: number, tier = 'auto'): SpawnSyncReturns<string> => {
      writeFileSync(sysctl, `#!/bin/bash\necho ${String(memoryGiB * 1024 ** 3)}\n`)
      chmodSync(sysctl, 0o755)
      return spawnSync('/bin/bash', [resolve('scripts/portable/model-path.sh'), root, tier], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      })
    }
    for (const [index, memory] of [16, 32, 64].entries()) {
      const result = run(memory)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), models[index])
    }
    assert.equal(run(64, 'small').stdout.trim(), models[0])
    const oversized = run(32, 'large')
    assert.equal(oversized.status, 1)
    assert.match(oversized.stderr, /64 GiB memory tier/)
    assert.equal(run(8).status, 1)
    assert.equal(run(64, 'unknown').status, 1)
    assert.ok(models[2])
    rmSync(models[2])
    assert.equal(run(64).stdout.trim(), models[1])
    assert.equal(run(64, 'large').status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
