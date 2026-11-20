/**
 * Who the main-process GitHub broker issues a grant to (execution-runtime-security
 * R2): a contained command only while `gh_api_read` would itself run without a
 * prompt, never an automation principal, with grant state that no sandbox
 * profile may write, and with a github.com login only.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RuntimeProfile } from '@shared/threads/execution-runtime.ts'
import type { BrokeredCredential } from '../../project-sandbox/local-runtime.ts'
import { setAutomationRunCorroborator } from '../execution-runtime/principal.ts'
import { setToolPermissionForExecution } from '../security/tool-permissions.ts'
import { setSetting } from '../storage/settings.ts'
import type { ThreadExecutionContext } from '../thread-execution-context-store.ts'
import { runWithToolAvailability } from '../tool-availability.ts'
import type { RecordDecisionInput } from '../security/decision-log-store.ts'
import { GITHUB_BROKER_REQUEST_TIMEOUT_MS } from './github-broker.ts'
import {
  createGitHubDotComTokenResolver,
  createLocalGitHubBroker,
  ghApiReadRunsUnprompted,
  githubGrantStateDir,
  localGitHubBrokerDefaults,
} from './local-github-broker.ts'

const CONTAINED: RuntimeProfile = { kind: 'local', containment: 'contained' }
const HOST: RuntimeProfile = { kind: 'local', containment: 'host' }

const interactive: ThreadExecutionContext = {
  projectId: 'proj',
  threadId: 'thread-a',
  projectRoot: '/repo',
  root: '/repo',
  checkoutMode: 'shared',
  branch: null,
}

const scheduled: ThreadExecutionContext = {
  ...interactive,
  automation: { scheduleId: 'nightly', scheduleName: 'Nightly', triggeredAt: 1_700_000_000_000 },
}

describe('local GitHub broker', () => {
  let copseDir: string
  let previousCopseDir: string | undefined
  let records: RecordDecisionInput[]
  let issued: BrokeredCredential[]

  function broker(
    context: ThreadExecutionContext,
    readsRunUnprompted: () => boolean = () => true,
  ): ReturnType<typeof createLocalGitHubBroker> {
    return createLocalGitHubBroker({
      broker: {
        resolveToken: () => Promise.resolve('token'),
        upstream: () => Promise.reject(new Error('no upstream in this test')),
        record: (input) => {
          records.push(input)
        },
        now: Date.now,
        stateDir: githubGrantStateDir,
        requestTimeoutMs: GITHUB_BROKER_REQUEST_TIMEOUT_MS,
      },
      context: () => context,
      readsRunUnprompted,
    })
  }

  async function issue(
    context: ThreadExecutionContext,
    profile: RuntimeProfile,
    readsRunUnprompted?: () => boolean,
  ): Promise<BrokeredCredential | null> {
    const credential = await broker(
      context,
      readsRunUnprompted,
    )({
      profile,
      readOnly: profile.kind === 'local' && profile.containment === 'contained',
    })
    if (credential) issued.push(credential)
    return credential
  }

  beforeEach(async () => {
    previousCopseDir = process.env['COPSE_DIR']
    copseDir = mkdtempSync(join(tmpdir(), 'copse-local-gh-'))
    process.env['COPSE_DIR'] = copseDir
    records = []
    issued = []
    await setSetting('toolPermissionOverrides', {})
  })

  afterEach(async () => {
    await Promise.all(issued.map((credential) => credential.release()))
    setAutomationRunCorroborator(null)
    await setSetting('toolPermissionOverrides', {})
    if (previousCopseDir === undefined) delete process.env['COPSE_DIR']
    else process.env['COPSE_DIR'] = previousCopseDir
    rmSync(copseDir, { recursive: true, force: true })
  })

  it('keeps grant state in a private directory of the Copse profile', async () => {
    const runDir = realpathSync(copseDir) + '/run'
    assert.equal(localGitHubBrokerDefaults().broker.stateDir(), runDir)
    assert.equal(statSync(runDir).mode & 0o777, 0o700)
    const credential = await issue(interactive, HOST)
    assert.ok(credential)
    assert.equal(dirname(credential.configDir), runDir)
    assert.equal(dirname(credential.socketPath), credential.configDir)
  })

  it('gives a contained command no grant unless gh_api_read runs unprompted', async () => {
    assert.equal(await issue(interactive, CONTAINED, () => false), null)
    assert.ok(await issue(interactive, CONTAINED, () => true))
    // An approved command outside the sandbox already holds the user's access.
    assert.ok(await issue(interactive, HOST, () => false))
    assert.equal(localGitHubBrokerDefaults().readsRunUnprompted, ghApiReadRunsUnprompted)
  })

  it('treats a per-tool Ask or Block on gh_api_read as no read grant', async () => {
    await runWithToolAvailability({ rg: true, git: true, gh: true }, async () => {
      assert.equal(ghApiReadRunsUnprompted(), true)
      await setToolPermissionForExecution('gh_api_read', 'block')
      assert.equal(ghApiReadRunsUnprompted(), false)
      await setToolPermissionForExecution('gh_api_read', 'ask')
      assert.equal(ghApiReadRunsUnprompted(), false)
      await setToolPermissionForExecution('gh_api_read', 'allow')
      assert.equal(ghApiReadRunsUnprompted(), true)
    })
    // Without gh, gh_api_read is not registered at all.
    runWithToolAvailability({ rg: true, git: true, gh: false }, () => {
      assert.equal(ghApiReadRunsUnprompted(), false)
    })
  })

  it('issues no grant to an automation principal', async () => {
    setAutomationRunCorroborator(() => true)
    assert.equal(await issue(scheduled, HOST), null)
    assert.equal(await issue(scheduled, CONTAINED), null)
    assert.deepEqual(records, [])
    // The same thread without a corroborated schedule acts for the human.
    setAutomationRunCorroborator(() => false)
    assert.ok(await issue(scheduled, HOST))
  })
})

describe('github.com token resolver', () => {
  it('never returns an Enterprise token and asks gh for github.com by name', async () => {
    const asked: string[][] = []
    const resolve = createGitHubDotComTokenResolver(
      {
        GH_ENTERPRISE_TOKEN: 'ghe-token',
        GITHUB_ENTERPRISE_TOKEN: 'ghe-token',
        GH_HOST: 'ghe.corp',
      },
      (args) => {
        asked.push(args)
        return Promise.resolve({ stdout: '', code: 1 })
      },
    )
    assert.equal(await resolve(), null)
    assert.deepEqual(asked, [['auth', 'token', '--hostname', 'github.com']])
  })

  it('prefers GH_TOKEN, then GITHUB_TOKEN, then caches a successful gh lookup', async () => {
    let calls = 0
    const runAuthToken = (): Promise<{ stdout: string; code: number }> => {
      calls += 1
      return Promise.resolve({ stdout: 'gho_login\n', code: 0 })
    }
    assert.equal(
      await createGitHubDotComTokenResolver({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, runAuthToken)(),
      'a',
    )
    assert.equal(await createGitHubDotComTokenResolver({ GITHUB_TOKEN: 'b' }, runAuthToken)(), 'b')
    assert.equal(calls, 0)
    const fromGh = createGitHubDotComTokenResolver({}, runAuthToken)
    assert.equal(await fromGh(), 'gho_login')
    assert.equal(await fromGh(), 'gho_login')
    assert.equal(calls, 1)
  })
})
