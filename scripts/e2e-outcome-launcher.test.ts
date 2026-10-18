import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseOutcome } from './lib/gate-evidence.mts'
const run = promisify(execFile)
it('real WDIO launcher emits failed and passed outer attempts against a local WebDriver fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wdio-outcome-'))
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          value:
            request.method === 'POST' && request.url === '/session'
              ? {
                  sessionId: 'fixture',
                  capabilities: { browserName: 'chrome', browserVersion: '1' },
                }
              : null,
        }),
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const address = server.address()
    assert(address && typeof address !== 'string')
    mkdirSync(join(root, 'tests/e2e'), { recursive: true })
    writeFileSync(
      join(root, 'tests/e2e/smoke.e2e.ts'),
      `import assert from 'node:assert/strict'; describe('fixture',()=>{it('outer attempt',()=>assert.equal(process.env.COPSE_E2E_ATTEMPT,'2'))})`,
    )
    writeFileSync(
      join(root, 'wdio.mjs'),
      `import {outcomeHooks} from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/e2e-outcomes.mts')).href)};
const hooks=outcomeHooks('outcomes', Number(process.env.COPSE_E2E_ATTEMPT));
export const config={hostname:'127.0.0.1',port:${String(address.port)},path:'/',specs:['./tests/e2e/smoke.e2e.ts'],capabilities:[{browserName:'chrome'}],framework:'mocha',reporters:[],logLevel:'error',maxInstances:1,mochaOpts:{timeout:5000},onWorkerStart(cid,caps,specs){hooks.start(cid,specs)},onWorkerEnd(cid,code,specs){hooks.end(cid,code,specs)}};`,
    )
    const cli = resolve('node_modules/@wdio/cli/bin/wdio.js')
    const logs: string[] = []
    for (const attempt of [1, 2]) {
      let failed = false
      try {
        const result = await run(process.execPath, [cli, 'run', 'wdio.mjs'], {
          cwd: root,
          timeout: 30_000,
          env: {
            ...process.env,
            GITHUB_RUN_ID: '1',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_SHA: 'a'.repeat(40),
            COPSE_E2E_ATTEMPT: String(attempt),
          },
        })
        logs.push(result.stdout, result.stderr)
      } catch (error) {
        logs.push(String(error))
        failed = true
      }
      assert.equal(failed, attempt === 1)
    }
    const rows = readdirSync(join(root, 'outcomes')).map((file) =>
      parseOutcome(readFileSync(join(root, 'outcomes', file), 'utf8')),
    )
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ['failed', 'passed'],
      logs.join('\n'),
    )
    assert.deepEqual(
      rows.map((row) => row.attempt),
      [1, 2],
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) =>
      server.close(() => {
        done()
      }),
    )
    rmSync(root, { recursive: true, force: true })
  }
})
