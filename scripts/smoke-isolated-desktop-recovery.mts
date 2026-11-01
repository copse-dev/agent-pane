/** Kill only our fixture parent, then exercise the product's crash recovery against its VM. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import { recoverIsolatedDesktops } from '../src/main/services/isolated-desktop/desktop-recovery.ts'

const readySchema = z
  .object({
    event: z.literal('orphan-ready'),
    name: z.string().regex(/^copse-desktop-probe-[a-f0-9-]{36}$/),
  })
  .strict()

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    [join(__dirname, 'smoke-isolated-desktop.cjs'), '--orphan-child'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (part: string) => {
    stderr = (stderr + part).slice(-8192)
  })
  const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (_code, signal) => {
      resolve(signal)
    })
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  let name: string | undefined
  try {
    name = await new Promise<string>((resolve, reject) => {
      let pending = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (part: string) => {
        pending += part
        if (Buffer.byteLength(pending) > 8192) {
          child.kill('SIGKILL')
          reject(new Error('Unexpected fixture parent output'))
          return
        }
        const newline = pending.indexOf('\n')
        if (newline < 0) return
        const ready = safeJsonParse(pending.slice(0, newline), decodeWithSchema(readySchema))
        if (!ready) reject(new Error('Invalid fixture readiness'))
        else resolve(ready.name)
      })
      child.once('error', reject)
      child.once('close', () => {
        reject(new Error('Fixture parent closed before readiness: ' + stderr))
      })
    })
    child.kill('SIGKILL')
    assert.equal(await exited, 'SIGKILL')
    await recoverIsolatedDesktops()
    await assert.rejects(readFile(join(copseDataRoot(), 'isolated-desktops', name + '.json')), {
      code: 'ENOENT',
    })
    const exec = promisify(execFile)
    await assert.rejects(
      exec('/usr/local/bin/container', ['inspect', name], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      }),
      (error: unknown) =>
        isRecord(error) &&
        typeof error['stderr'] === 'string' &&
        error['stderr'].includes(name ?? '') &&
        /not found|does not exist/i.test(error['stderr']),
    )
    console.log(JSON.stringify({ name, parent: 'SIGKILL', recovery: 'VM and lease removed' }))
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited.catch(() => undefined)
    await recoverIsolatedDesktops()
  }
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
