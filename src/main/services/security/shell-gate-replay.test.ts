// Replays the public escalation-review command set through the real permission gate
// (`ensureShellCommandPermitted`) under each cell of the platform matrix in
// docs/shell-permissions.md, and pins what the gate does with every command: run
// without a question, ask (and which question), or refuse.
//
// The benchmark's `gates.mjs` pins each analyser's verdict. This pins their
// composition (policy, auto-approval, read-outside proof, Guarded YOLO) as the user
// meets it. Nothing is executed: only the gate runs, with a handler that declines
// every prompt.
import assert from 'node:assert/strict'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AUTO_APPROVAL_LEVEL_SETTING, type AutoApprovalLevel } from '@shared/auto-approval.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { setApprovalHandler } from '../approval.ts'
import { deleteSetting, setSetting } from '../storage/settings.ts'
import { storageDelete, storageSet } from '../storage/storage.ts'
import {
  clearActiveRunThread,
  runWithActiveRunIdentity,
  setActiveRunThread,
} from '../thread-models.ts'
import { setPermissionGateForTests } from '../tool-registry.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { readDecisionLog } from './decision-log-store.ts'
import { armGuardedYolo, disableGuardedYolo } from './guarded-yolo.ts'
import { ensureShellCommandPermitted } from './permission-gate.ts'
import { clearGitRemotesCache } from './git-remotes.ts'
import { clearWorkspaceTrustForTest, setWorkspaceTrusted } from './workspace-trust.ts'

// The corpus is anonymised onto one machine: home /Users/dev, workspace /Users/dev/project.
// The gate reads the real filesystem (git remotes, scripts), so the replay moves that
// machine under a scratch directory and rewrites each command to match.
const ANONYMISED_HOME = '/Users/dev'
let replays = 0
const SNAPSHOT = resolve('benchmarks/escalation-review/testset/gate-replay.jsonl')
const CASES = resolve('benchmarks/escalation-review/testset/cases.jsonl')

interface Situation {
  name: string
  sandboxEnabled: boolean
  autoRun: boolean
  guardedYolo: boolean
  level: AutoApprovalLevel
}

const SITUATIONS: readonly Situation[] = [
  { name: 'sandbox', sandboxEnabled: true, autoRun: true, guardedYolo: false, level: 'read' },
  {
    name: 'sandbox-remote-write',
    sandboxEnabled: true,
    autoRun: true,
    guardedYolo: false,
    level: 'remote-write',
  },
  { name: 'no-sandbox', sandboxEnabled: false, autoRun: true, guardedYolo: false, level: 'read' },
  { name: 'auto-run-off', sandboxEnabled: true, autoRun: false, guardedYolo: false, level: 'read' },
  { name: 'yolo-sandbox', sandboxEnabled: true, autoRun: true, guardedYolo: true, level: 'read' },
  {
    name: 'yolo-no-sandbox',
    sandboxEnabled: false,
    autoRun: true,
    guardedYolo: true,
    level: 'read',
  },
]

interface CorpusCase {
  id: string
  command: string
  tier: string
  trustedSshHosts: string[]
  hasFiles: boolean
}

const corpusCaseSchema = z.object({
  id: z.string(),
  command: z.string(),
  tier: z.string(),
  trustedSshHosts: z.unknown().optional(),
  files: z.unknown().optional(),
})

async function loadCases(): Promise<CorpusCase[]> {
  const rows: CorpusCase[] = []
  for (const line of (await readFile(CASES, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    const row = safeJsonParse(line, decodeWithSchema(corpusCaseSchema))
    assert.ok(row, 'Invalid command corpus row')
    const hosts = row.trustedSshHosts
    rows.push({
      id: row.id,
      command: row.command,
      tier: row.tier,
      trustedSshHosts: Array.isArray(hosts) ? hosts.filter((h) => typeof h === 'string') : [],
      hasFiles: isRecord(row.files) && Object.keys(row.files).length > 0,
    })
  }
  return rows
}

/** What the gate did with one command, as one comparable string. */
type Outcome = string

// A decision whose `source` is one of these let a command through unasked.
const UNASKED_SOURCES = new Set(['auto-approval', 'trusted-command', 'read-outside-grant'])

describe('shell gate replay', () => {
  let fixtureRoot = ''
  let home = ''
  let outsideWorkspace = ''
  let workspace = ''
  let previousHome: string | undefined
  let previousWorkspace: string | undefined
  let restoreRoot: (() => void) | null = null
  let prompts: (string | undefined)[] = []

  beforeEach(async () => {
    // Under the repository, not the OS temp directory: the harm gate treats
    // /tmp and /var/folders specially, which would change what it decides.
    await mkdir(resolve('.tmp'), { recursive: true })
    fixtureRoot = await realpath(await mkdtemp(resolve('.tmp', 'gate-replay-')))
    home = join(fixtureRoot, 'home')
    outsideWorkspace = join(fixtureRoot, 'outside-workspace')
    workspace = join(home, 'project')
    await mkdir(outsideWorkspace, { recursive: true })
    await mkdir(join(workspace, '.git'), { recursive: true })
    // A configured remote is what lets the remote-write tier recognise `origin`.
    await writeFile(
      join(workspace, '.git', 'config'),
      '[remote "origin"]\n\turl = https://example.com/project.git\n',
    )
    previousHome = process.env['HOME']
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    // shell analysis resolves `~` through os.homedir(), which reads HOME.
    process.env['HOME'] = home
    process.env['COPSE_WORKSPACE_DIR'] = join(home, 'store')
    setPermissionGateForTests(null)
    await setSetting('safetyClassifierEnabled', false)
    clearGitRemotesCache()
    setWorkspaceTrusted(workspace, true)
    restoreRoot = setWorkspaceRootForTest(workspace)
    setApprovalHandler((request) => {
      prompts.push(request.cause)
      return Promise.resolve({ approved: false, remember: false })
    })
  })

  afterEach(async () => {
    setApprovalHandler(null)
    restoreRoot?.()
    clearWorkspaceTrustForTest()
    await deleteSetting(AUTO_APPROVAL_LEVEL_SETTING)
    await deleteSetting('autoRunSandboxCommands')
    await deleteSetting('trustedSshHosts')
    if (previousHome !== undefined) process.env['HOME'] = previousHome
    else delete process.env['HOME']
    if (previousWorkspace !== undefined) process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    else delete process.env['COPSE_WORKSPACE_DIR']
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  async function replay(situation: Situation, testCase: CorpusCase): Promise<Outcome> {
    // Auto-run is a setting the gate's other paths (trusted-command routing,
    // auto-approval) read themselves, so it is set rather than passed.
    await setSetting('autoRunSandboxCommands', situation.autoRun)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, situation.level)
    await setSetting('trustedSshHosts', testCase.trustedSshHosts)
    prompts = []
    // A fresh project and thread per replay keeps each decision log to this
    // one command, so reading it back stays cheap across thousands of replays.
    replays += 1
    const project = `gate-replay-project-${String(replays)}`
    const thread = `gate-replay-thread-${String(replays)}`
    storageSet('activeProjectId', project)
    return runWithActiveRunIdentity(thread, async () => {
      if (situation.guardedYolo) armGuardedYolo(thread)
      setActiveRunThread(thread)
      try {
        const permitted = await ensureShellCommandPermitted(
          // Corpus /workspace is an unrelated outside tree, even when the actual
          // checkout lives below /workspace. One pass prevents rewriting the
          // physical paths introduced for the anonymised home.
          testCase.command.replace(
            /\/Users\/dev(?=$|\/|[\s'";|&<>),])|\/workspace(?=$|\/|[\s'";|&<>),])/g,
            (path) => (path === ANONYMISED_HOME ? home : outsideWorkspace),
          ),
          { sandboxEnabled: situation.sandboxEnabled, executionRoot: workspace },
        )
        const log = await readDecisionLog(project)
        if (!permitted) return `prompt:${prompts.join('+') || 'declined'}`
        const unasked = log.flatMap((e) =>
          e.source !== undefined && UNASKED_SOURCES.has(e.source) ? [e.source] : [],
        )[0]
        if (unasked !== undefined) return `allow:outside:${unasked}`
        // Guarded YOLO records where the command runs; standard mode allows
        // only commands the sandbox contains.
        if (situation.guardedYolo) {
          return log.some((e) => e.scope === 'external') ? 'allow:outside' : 'allow:contained'
        }
        return 'allow:contained'
      } catch (error) {
        assert.ok(error instanceof Error)
        return error.message.startsWith('Command blocked') ? 'deny' : `error:${error.message}`
      } finally {
        clearActiveRunThread(thread)
        disableGuardedYolo(thread)
        storageDelete('activeProjectId')
      }
    })
  }

  it('pins what the gate does with every command in every situation', async () => {
    const cases = (await loadCases()).filter((c) => !c.hasFiles)
    const rows: { id: string; tier: string; outcomes: Record<string, Outcome> }[] = []
    for (const testCase of cases) {
      const outcomes: Record<string, Outcome> = {}
      for (const situation of SITUATIONS)
        outcomes[situation.name] = await replay(situation, testCase)
      rows.push({ id: testCase.id, tier: testCase.tier, outcomes })
    }
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    if (process.env['UPDATE_GATE_REPLAY'] === '1') await writeFile(SNAPSHOT, text)

    // Invariants, whatever the snapshot says.
    const problems: string[] = []
    for (const row of rows) {
      for (const [name, outcome] of Object.entries(row.outcomes)) {
        if (outcome.startsWith('error:')) problems.push(`${row.id} [${name}] ${outcome}`)
        // Nothing contains a command here, so nothing runs without a question
        // except a Guarded YOLO the user turned on.
        if (/^(no-sandbox|auto-run-off)$/.test(name) && outcome.startsWith('allow')) {
          problems.push(`${row.id} [${name}] ran without a question: ${outcome}`)
        }
        // A command a person must see never leaves the sandbox unasked.
        if (row.tier === 'ask' && outcome.startsWith('allow:outside')) {
          problems.push(`${row.id} [${name}] labelled ask, ran outside unasked: ${outcome}`)
        }
      }
    }
    assert.deepEqual(problems, [])

    const pinned = await readFile(SNAPSHOT, 'utf8')
    const expectedLines = pinned.trimEnd().split('\n')
    const actualLines = text.trimEnd().split('\n')
    assert.deepEqual(
      actualLines.filter((line, index) => line !== expectedLines[index]),
      [],
      'Replay outcomes changed; inspect each differing row against the checked-in snapshot.',
    )
    assert.equal(
      text,
      pinned,
      'The gate decides differently from the pinned replay. Review the diff, then run with UPDATE_GATE_REPLAY=1.',
    )
  })
})
