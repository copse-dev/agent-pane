import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { installFakeSshHost, type FakeSshHost } from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

const HOST_ID = 'dev'

const startResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  uploaded: z.boolean().optional(),
  hello: z
    .object({
      version: z.string(),
      pid: z.number(),
      capabilities: z.object({ roles: z.array(z.string()) }),
    })
    .nullable()
    .optional(),
})
type StartResult = z.infer<typeof startResultSchema>

/** Ask the app to start the worker; the answer is read by `startResult`. */
async function startWorker(): Promise<void> {
  await browser.execute((hostId: string) => {
    const bridge = window.__copseE2e
    if (!bridge) throw new Error('__copseE2e.startSshWorker unavailable')
    window.__sshWorkerStart = undefined
    void bridge.startSshWorker(hostId).then(
      (value) => {
        window.__sshWorkerStart = value
      },
      (error: unknown) => {
        window.__sshWorkerStart = { ok: false, reason: String(error) }
      },
    )
  }, HOST_ID)
}

async function startResult(): Promise<StartResult> {
  let result: StartResult | undefined
  await browser.waitUntil(
    async () => {
      const value = await browser.execute(() => window.__sshWorkerStart)
      const parsed = startResultSchema.safeParse(value)
      if (parsed.success) result = parsed.data
      return result !== undefined
    },
    { timeout: 150_000, timeoutMsg: 'starting the worker never finished' },
  )
  assert.ok(result)
  return result
}

/**
 * The worker on an SSH host (docs/plans/harness-worker-roadmap.md, R3): the
 * app uploads it with the user's consent, starts it with the host's Node and
 * says hello over a forwarded socket. The fake host is this machine, with its
 * own home, so the worker really runs from what was uploaded.
 */
describe('Copse worker on an SSH host', () => {
  let host: FakeSshHost
  let remoteHome: string
  /** The worker this spec started on the "host", which is this machine. */
  let workerPid: number | undefined

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    remoteHome = mkdtempSync(join(tmpdir(), 'copse-e2e-ssh-worker-home-'))
    host = installFakeSshHost({ remoteHome })
    seedEmptyProject(host.remoteRoot, 'e2e-ssh-worker-start', { sshHost: HOST_ID })
    seedSshWorkspaceSettings({ hosts: true })
    await browser.reloadSession()
  })

  after(() => {
    if (workerPid !== undefined)
      try {
        process.kill(workerPid)
      } catch {
        // already gone
      }
    host.remove()
    resetUserData()
  })

  it('asks, uploads the worker, starts it and says hello over the forward', async function () {
    this.timeout(180_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.api.sshWorkspace.getStates())).some(
          (state) => state.hostId === 'dev' && state.status === 'connected',
        ),
      { timeout: 30_000, timeoutMsg: 'the SSH project never connected' },
    )
    await startWorker()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 60_000 })
    await expect(dialog.$('.approval-heading')).toHaveText("Run Copse's worker on Dev Server?")
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('~/.copse/worker')
    expect(body).toContain('Your model keys stay on this computer')
    await saveElementScreenshot('#approval-dialog', 'ssh-worker-install-approval.png')
    await dialog.$('.approval-approve').click()

    const started = await startResult()
    assert.equal(started.ok, true, started.reason ?? '')
    assert.equal(started.uploaded, true)
    assert.ok(started.hello, 'the worker said hello')
    workerPid = started.hello.pid
    assert.deepEqual(started.hello.capabilities.roles, ['turns'])

    // One install, named by the build, holding the bundle and the runtime it
    // loads, beside the profile every build shares.
    const entries = readdirSync(join(remoteHome, '.copse', 'worker'))
    assert.ok(entries.includes('profile'))
    const installs = entries.filter((name) => name !== 'profile')
    assert.equal(installs.length, 1)
    const dir = join(remoteHome, '.copse', 'worker', installs[0] ?? '')
    assert.ok(existsSync(join(dir, 'ssh-worker.cjs')))
    assert.ok(existsSync(join(dir, 'node_modules', '@anthropic-ai', 'sandbox-runtime')))

    // Again in the same app run: no second question, no second upload, and the
    // worker already serving answers.
    await startWorker()
    const again = await startResult()
    assert.equal(again.ok, true, again.reason ?? '')
    assert.equal(again.uploaded, false)
    assert.equal(again.hello?.pid, workerPid)
  })
})
