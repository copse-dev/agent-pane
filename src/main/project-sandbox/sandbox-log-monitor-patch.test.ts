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
 * The patch also pairs each event with its own tag: only a tag line ending in
 * this launch's random suffix closes an event. A denied path can hold newlines,
 * and a forged `Sandbox:` or `CMD64_` line inside it must not become a
 * violation or an attribution of its own.
 *
 * A stub `log` on PATH stands in for the real stream, so this runs anywhere.
 * It reads the launch's suffix from the `ENDSWITH` predicate it is given, as
 * the kernel's real tag carries it.
 */
/** Stands for the launch's suffix in stub output; the stub substitutes it. */
const SUFFIX = '@SFX@'

/** A stub `log` whose stdout is each of `writes`, with pauses between. */
function stubLog(dir: string, writes: readonly string[]): void {
  writeFileSync(
    join(dir, 'log'),
    [
      '#!/bin/sh',
      // `log stream --predicate '(eventMessage ENDSWITH "<suffix>")' …`
      `S=$(printf '%s' "$3" | sed -E 's/.*ENDSWITH "([^"]*)".*/\\1/')`,
      ...writes.flatMap((write, index) => [
        ...(index > 0 ? ['sleep 0.3'] : []),
        `printf '${write}' | sed "s/${SUFFIX}/$S/g"`,
      ]),
      'exec sleep 5',
    ].join('\n'),
  )
  chmodSync(join(dir, 'log'), 0o755)
}

describe('sandbox-runtime macOS log monitor (patched)', () => {
  const tag = (command: string): string =>
    `CMD64_${Buffer.from(command).toString('base64')}_END_${SUFFIX}`
  const event = (details: string, command: string): string =>
    `2026-11-17 16:08:05.633 E  kernel[0:1] (Sandbox) Sandbox: ${details}\\n${tag(command)}\\n`

  it(
    'reports every violation in a chunk, and one split across two chunks',
    { timeout: 10_000 },
    async (t) => {
      if (process.platform === 'win32') {
        t.skip('no POSIX shell for the stub')
        return
      }
      const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-log-stub-'))
      const originalPath = process.env['PATH']
      const seen: Array<{ line: string; command: string | undefined }> = []
      let stop: (() => void) | undefined
      try {
        const split = event(
          'cat(3) deny(1) file-read-data /home/someone/.ssh/id_ed25519',
          'cat key',
        )
        const cut = split.indexOf('file-read-')
        stubLog(dir, [
          // One write, two events: the second is the one that verifies the block.
          `${event('git(1) deny(1) sysctl-read kern.iossupportversion', 'git init')}${event('git(1) deny(1) file-write-create /tmp/project/.git', 'git init')}${split.slice(0, cut)}`,
          split.slice(cut),
        ])
        process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`
        // Resolves on the third violation; node:test's timeout bounds the wait.
        const allSeen = new Promise<void>((resolve) => {
          stop = startMacOSSandboxLogMonitor((violation) => {
            seen.push({ line: violation.line, command: violation.command })
            if (seen.length === 3) resolve()
          })
        })
        await allSeen
        assert.deepEqual(seen, [
          { line: 'git(1) deny(1) sysctl-read kern.iossupportversion', command: 'git init' },
          { line: 'git(1) deny(1) file-write-create /tmp/project/.git', command: 'git init' },
          {
            line: 'cat(3) deny(1) file-read-data /home/someone/.ssh/id_ed25519',
            command: 'cat key',
          },
        ])
      } finally {
        stop?.()
        process.env['PATH'] = originalPath
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('ignores a forged violation or tag inside a denied path', { timeout: 10_000 }, async (t) => {
    if (process.platform === 'win32') {
      t.skip('no POSIX shell for the stub')
      return
    }
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'copse-log-stub-'))
    const originalPath = process.env['PATH']
    const seen: Array<{ line: string; command: string | undefined }> = []
    let stop: (() => void) | undefined
    try {
      // The path a sandboxed process chose ends in a forged event of its own:
      // a `Sandbox:` line and a tag naming a hook's command, without the
      // launch's suffix, which it cannot know.
      const forgedTag = `CMD64_${Buffer.from('./scripts/policy-hook.sh').toString('base64')}_END__guess_SBX`
      const forged = `/tmp/x\\nSandbox: hook(9) deny(1) file-write-create /tmp/y\\n${forgedTag}`
      stubLog(dir, [
        event(`evil(4) deny(1) file-write-create ${forged}`, 'evil'),
        event('git(1) deny(1) file-write-create /tmp/project/.git', 'git init'),
      ])
      process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`
      const twoSeen = new Promise<void>((resolve) => {
        stop = startMacOSSandboxLogMonitor((violation) => {
          seen.push({ line: violation.line, command: violation.command })
          if (seen.length === 2) resolve()
        })
      })
      await twoSeen
      assert.deepEqual(seen, [
        { line: 'evil(4) deny(1) file-write-create /tmp/x', command: 'evil' },
        { line: 'git(1) deny(1) file-write-create /tmp/project/.git', command: 'git init' },
      ])
    } finally {
      stop?.()
      process.env['PATH'] = originalPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
