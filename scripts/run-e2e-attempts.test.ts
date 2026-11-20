import assert from 'node:assert/strict'
import { it } from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

it('default local runs keep ordinary failure logs without accumulating managed snapshots', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-e2e-local-')))
  try {
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules/.bin/wdio'),
      `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const failed = process.argv.includes('fail.mjs');
const directory = process.env.COPSE_E2E_DIAGNOSTICS_DIR || path.join(process.cwd(), 'e2e-failure-artifacts/wdio-logs');
fs.mkdirSync(directory, {recursive:true});
fs.writeFileSync(path.join(directory, 'wdio-0-0-chromedriver.log'), failed ? 'failed driver protocol' : 'passed driver protocol');
if (failed) fs.writeFileSync(path.join(process.cwd(), 'e2e-failure-artifacts/failure.html'), 'original failure DOM');
process.exit(failed ? 7 : 0);
`,
      { mode: 0o755 },
    )
    const runner = resolve('scripts/run-e2e.mts')
    for (const config of ['fail.mjs', 'pass.mjs']) {
      const result = spawnSync(process.execPath, [runner, config], {
        cwd: root,
        env: {
          ...process.env,
          COPSE_E2E_ATTEMPT: undefined,
          COPSE_E2E_DIAGNOSTICS_DIR: undefined,
          COPSE_E2E_HEADLESS: '0',
          DISPLAY: ':fixture',
        },
        encoding: 'utf8',
        timeout: 20_000,
      })
      assert.equal(result.status, config === 'fail.mjs' ? 7 : 0, result.stderr)
      const logs = join(root, 'e2e-failure-artifacts/wdio-logs')
      assert.deepEqual(
        readdirSync(logs).filter((name) => name.startsWith('attempt-')),
        [],
      )
      assert.equal(
        readFileSync(join(logs, 'wdio-0-0-chromedriver.log'), 'utf8'),
        config === 'fail.mjs' ? 'failed driver protocol' : 'passed driver protocol',
      )
      assert.equal(
        readFileSync(join(root, 'e2e-failure-artifacts/failure.html'), 'utf8'),
        'original failure DOM',
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('the real run-e2e boundary preserves raw attempts and original command exit/signal results', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-e2e-attempts-')))
  try {
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules/.bin/wdio'),
      `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const failed = process.argv.includes('fail.mjs');
const directory = process.env.COPSE_E2E_DIAGNOSTICS_DIR || path.join(process.cwd(), 'e2e-failure-artifacts/wdio-logs');
fs.mkdirSync(directory, {recursive:true});
fs.writeFileSync(path.join(directory, 'wdio-0-0-chromedriver.log'), Buffer.from(failed ? [0,255,13,10] : [7,8,9]));
console.error(failed ? 'original fixture error' : 'original fixture success');
if (process.argv.includes('signal.mjs')) process.kill(process.pid, 'SIGTERM');
process.exit(failed ? 7 : 0);
`,
      { mode: 0o755 },
    )
    const runner = resolve('scripts/run-e2e.mts')
    const results = ['fail.mjs', 'pass.mjs', 'signal.mjs'].map((config) =>
      spawnSync(process.execPath, [runner, config], {
        cwd: root,
        env: {
          ...process.env,
          COPSE_E2E_ATTEMPT: '1',
          COPSE_E2E_HEADLESS: '0',
          DISPLAY: ':fixture',
        },
        encoding: 'utf8',
        timeout: 20_000,
      }),
    )
    assert.deepEqual(
      results.map((result) => result.status),
      [7, 0, null],
    )
    assert(results[0]?.stderr.includes('original fixture error'))
    assert.equal(results[2]?.signal, 'SIGTERM')
    const logs = join(root, 'e2e-failure-artifacts/wdio-logs')
    const directories = readdirSync(logs).filter((name) => name.startsWith('attempt-1-'))
    assert.equal(directories.length, 3, 'all managed attempts must survive the reused basename')
    const hashes = directories.map((name) => {
      const bytes = readFileSync(join(logs, name, 'snapshot', 'wdio-0-0-chromedriver.log'))
      const manifest = safeJsonParse(
        readFileSync(join(logs, name, 'snapshot', 'manifest.json'), 'utf8'),
        decodeWithSchema(
          z.object({
            driverEof: z.literal('unknown'),
            files: z.array(z.object({ name: z.string(), sha256: z.string() })),
          }),
        ),
      )
      assert(manifest)
      const hash = createHash('sha256').update(bytes).digest('hex')
      assert.equal(
        manifest.files.find((file) => file.name === 'wdio-0-0-chromedriver.log')?.sha256,
        hash,
      )
      return hash
    })
    assert.deepEqual(
      hashes.sort(),
      [Buffer.from([0, 255, 13, 10]), Buffer.from([7, 8, 9]), Buffer.from([7, 8, 9])]
        .map((bytes) => createHash('sha256').update(bytes).digest('hex'))
        .sort(),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('the outer-attempt CLI seals partial output when the runner never recorded an exit', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-e2e-partial-')))
  try {
    const cli = resolve('scripts/e2e-attempt-artifacts.mts')
    const started = spawnSync(process.execPath, [cli, 'start', '2'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(started.status, 0, started.stderr)
    const directory = started.stdout.trim()
    assert(directory.startsWith(join(root, 'e2e-failure-artifacts/wdio-logs/attempt-2-')))
    writeFileSync(join(directory, 'wdio-0-0-chromedriver.log'), 'partial protocol')
    const finished = spawnSync(process.execPath, [cli, 'finish', directory, '124'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(finished.status, 0, finished.stderr)
    const manifest = safeJsonParse(
      readFileSync(join(directory, 'snapshot/manifest.json'), 'utf8'),
      decodeWithSchema(
        z.object({
          launchResultAvailable: z.literal(false),
          driverEof: z.literal('unknown'),
          driverExitCode: z.null(),
          driverSignal: z.null(),
        }),
      ),
    )
    assert(manifest)
    assert.equal(
      readFileSync(join(directory, 'snapshot/wdio-0-0-chromedriver.log'), 'utf8'),
      'partial protocol',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
