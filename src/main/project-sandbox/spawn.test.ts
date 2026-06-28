import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { formatArgvForShell, shellForSandboxWrap } from './spawn.ts'

describe('formatArgvForShell', () => {
  it('keeps workspace and Electron paths with spaces as single shell words', () => {
    const exec = '/Users/me/debugging/e research/agent-pane/node_modules/electron/dist/Electron'
    const worker = '/Users/me/debugging/e research/agent-pane/dist/main/sandbox-fs-worker.js'
    const command = formatArgvForShell(exec, [worker])
    assert.match(command, /^'\/Users\/me\/debugging\/e research\/agent-pane/)
  })

  it('quotes only executable and worker paths (request travels via env when sandboxed)', () => {
    const exec = '/tmp/e research/Electron'
    const worker = '/tmp/e research/sandbox-fs-worker.js'
    const command = formatArgvForShell(exec, [worker])
    assert.equal(command.includes('statDir'), false)
    assert.equal(command, `'${exec}' '${worker}'`)
  })

  it('runs a spaced executable path under bash -c without splitting on spaces', () => {
    const dir = '/tmp/copse spaced spawn test'
    const execPath = `${dir}/fake-electron`
    const workerPath = `${dir}/worker.js`
    const command = formatArgvForShell(execPath, [workerPath])
    const script = [
      `mkdir -p ${JSON.stringify(dir)}`,
      `printf '#!/bin/sh\\necho OK\\n' > ${JSON.stringify(execPath)}`,
      `chmod +x ${JSON.stringify(execPath)}`,
      `touch ${JSON.stringify(workerPath)}`,
      command,
    ].join('; ')
    const out = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }).trim()
    assert.equal(out, 'OK')
  })
})

describe('shellForSandboxWrap', () => {
  it('uses a PATH-resolvable shell name for absolute macOS shell paths', () => {
    const originalPath = process.env['PATH']
    process.env['PATH'] = '/custom/bin'
    try {
      assert.equal(shellForSandboxWrap('/bin/bash'), 'bash')
      assert.match(process.env['PATH'] ?? '', /(?:^|:)\/bin(?::|$)/)
      assert.match(process.env['PATH'] ?? '', /(?:^|:)\/usr\/bin(?::|$)/)
    } finally {
      process.env['PATH'] = originalPath
    }
  })
})
