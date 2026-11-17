import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { startMacOSSandboxLogMonitor } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'

/**
 * Guards `patches/@anthropic-ai__sandbox-runtime@0.0.74.patch`.
 *
 * `log stream` writes whatever has accumulated, so under load one stdout chunk
 * carries several sandbox events, and a line can straddle two chunks. Upstream
 * read only the first violation in each chunk, so a busy machine dropped the
 * `.git` denial that verifies a blocked `git init`: 13 of 40 attempts under
 * CPU load, although the kernel logged all 40. The patch reads every line.
 *
 * A stub `log` on PATH stands in for the real stream, so this runs anywhere.
 */
describe('sandbox-runtime macOS log monitor (patched)', () => {
  const tag = (command: string): string =>
    `CMD64_${Buffer.from(command).toString('base64')}_END__stub_SBX`
  const event = (details: string, command: string): string =>
    `2026-11-17 16:08:05.633 E  kernel[0:1] (Sandbox) Sandbox: ${details}\\n${tag(command)}\\n`

  it('reports every violation in a chunk, and one split across two chunks', async (t) => {
    if (process.platform === 'win32') {
      t.skip('no POSIX shell for the stub')
      return
    }
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-log-stub-'))
    const originalPath = process.env['PATH']
    const seen: Array<{ line: string; command: string | undefined }> = []
    let stop: (() => void) | undefined
    try {
      const split = event('cat(3) deny(1) file-read-data /home/someone/.ssh/id_ed25519', 'cat key')
      const cut = split.indexOf('file-read-')
      writeFileSync(
        join(dir, 'log'),
        [
          '#!/bin/sh',
          // One write, two events: the second is the one that verifies the block.
          `printf '${event('git(1) deny(1) sysctl-read kern.iossupportversion', 'git init')}${event('git(1) deny(1) file-write-create /tmp/project/.git', 'git init')}'`,
          `printf '${split.slice(0, cut)}'`,
          'sleep 0.3',
          `printf '${split.slice(cut)}'`,
          'sleep 5',
        ].join('\n'),
      )
      chmodSync(join(dir, 'log'), 0o755)
      process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`
      stop = startMacOSSandboxLogMonitor((violation) => {
        seen.push({ line: violation.line, command: violation.command })
      })
      const deadline = Date.now() + 5_000
      while (seen.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.deepEqual(seen, [
        { line: 'git(1) deny(1) sysctl-read kern.iossupportversion', command: 'git init' },
        { line: 'git(1) deny(1) file-write-create /tmp/project/.git', command: 'git init' },
        { line: 'cat(3) deny(1) file-read-data /home/someone/.ssh/id_ed25519', command: 'cat key' },
      ])
    } finally {
      stop?.()
      process.env['PATH'] = originalPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
