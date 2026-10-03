import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '@shared/unknown-value.ts'
import {
  appleContainerAvailable,
  buildWorkerImage,
  dockerAvailable,
  listManagedRuntimes,
  runThreadInContainer,
  teardownRuntime,
} from './thread-container.ts'
import type { ThreadContainerEngine } from './container-engine.ts'
import { buildGuestProvider } from './guest-provider.ts'
import { withCredentialOutputRedaction } from '@copse/llm/credential-output-provider.ts'
import { HOST_INFERENCE_TARGET } from './host-inference-wire.ts'
import { GUEST_ALLOWED_TOOLS } from './guest-tools.ts'
import { createZipArchive } from '../storage/zip-archive.ts'
import { startScriptedModelServer } from './scripted-model-server.ts'
import { bundleThreadContainerWorker } from '../../../../scripts/lib/thread-container-worker-bundle.mts'

/**
 * The whole loop, for real: a scripted model behind the egress broker drives
 * the product's headless agent inside the hardened container, and the record
 * proves the properties the plan promises — no prompt reached a handler, the
 * outward effect was queued, the host escape was refused, the contained
 * destructive command ran, the work came back as commits, the host's secret
 * never entered the guest, and the container is gone afterwards.
 *
 * Opt-in: it builds an image and needs an engine, which the ordinary unit
 * gate must not depend on. `COPSE_THREAD_CONTAINER_E2E=1` runs it on Docker;
 * `COPSE_THREAD_CONTAINER_E2E=apple` runs the same scenario on Apple
 * container (Apple silicon, `container system start`), where it also proves
 * the guest declared containment under the VM attestation — no-new-privileges
 * from the entrypoint, the rlimit process cap, no interface but loopback.
 */

const E2E = process.env['COPSE_THREAD_CONTAINER_E2E']
const IMAGE = 'copse-worker:e2e'

/**
 * Runs inside the guest as an ordinary shell child of the agent: tries every
 * way a same-uid process could recover the run's egress token (decision A7)
 * and then uses whatever it recovered against the guest proxy.
 */
const TOKEN_PROBE = `
import fs from 'node:fs'
import net from 'node:net'
const read = (p) => { try { return fs.readFileSync(p) } catch { return null } }
const TOKEN = /\\/\\/run:([^@\\s]+)@127\\.0\\.0\\.1:3128/
let token = null
const readable = []
for (const pid of fs.readdirSync('/proc').filter((d) => /^\\d+$/.test(d))) {
  for (const file of ['environ', 'cmdline']) {
    const buf = read('/proc/' + pid + '/' + file)
    if (buf === null) continue
    const m = TOKEN.exec(buf.toString('latin1').replace(/\\0/g, ' '))
    if (m) { token ??= decodeURIComponent(m[1]); readable.push(pid + '/' + file) }
  }
}
const connect = (auth) => new Promise((resolve) => {
  const s = net.connect(3128, '127.0.0.1')
  let buf = ''
  s.setTimeout(8000, () => { s.destroy(); resolve('timeout') })
  s.on('error', (e) => resolve(e.code ?? 'error'))
  s.on('connect', () => s.write('CONNECT model.copse.internal:443 HTTP/1.1\\r\\nHost: model.copse.internal:443\\r\\n' + (auth ? 'Proxy-Authorization: ' + auth + '\\r\\n' : '') + '\\r\\n'))
  s.on('data', (d) => { buf += d; if (buf.includes('\\r\\n\\r\\n')) { s.destroy(); resolve(buf.split('\\r\\n')[0]) } })
})
const out = { uid: process.getuid(), recoveredFrom: readable, noAuth: await connect(null) }
if (token) out.withRecoveredToken = await connect('Basic ' + Buffer.from('run:' + token).toString('base64'))
console.log(JSON.stringify(out))
`

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function seedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'copse-tc-e2e-'))
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['config', 'user.email', 'test@copse.invalid'])
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  writeFileSync(
    join(dir, 'fixture.zip'),
    await createZipArchive([
      {
        path: 'inside.txt',
        data: Buffer.from('archive fixture'),
        modifiedAt: new Date(2026, 0, 1),
      },
    ]),
  )
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'init'])
  // Uncommitted work must travel too.
  writeFileSync(join(dir, 'notes.txt'), 'uncommitted\n')
  return dir
}

describe('thread in a container (end to end)', { skip: E2E !== '1' }, () => {
  it('runs a thread with no prompts, defers the outward effect, and brings the work back', async () => {
    assert.equal(await dockerAvailable(), true, 'docker daemon required')
    await endToEnd('docker')
  })
  it('keeps the run token out of reach of a shell command in the guest', async () => {
    assert.equal(await dockerAvailable(), true, 'docker daemon required')
    const workerBundle = await bundleThreadContainerWorker(
      join(tmpdir(), 'copse-thread-container-worker.e2e.cjs'),
    )
    await buildWorkerImage({ image: IMAGE, workerBundle })
    const model = await startScriptedModelServer([
      {
        kind: 'shell',
        command:
          'node probe.mjs > probe-out.json 2>&1; git add -f probe-out.json && git commit -q -m probe',
      },
      { kind: 'text', text: 'done' },
    ])
    const repo = seedRepo()
    writeFileSync(join(repo, 'probe.mjs'), TOKEN_PROBE)
    const runtimesDir = mkdtempSync(join(tmpdir(), 'copse-tc-runtimes-'))
    const logs: string[] = []
    try {
      const record = await runThreadInContainer(
        {
          workspace: repo,
          prompt: 'probe',
          model: 'scripted',
          provider: {
            kind: 'openai-compatible',
            model: 'scripted',
            apiKeySlug: 'scripted',
            url: `http://${GUEST_MODEL_ORIGIN}/v1`,
            label: 'the scripted model',
            local: true,
            includeUsage: true,
            apiStyle: null,
            extraBody: null,
            params: {},
          },
          budgets: { wallClockMs: 4 * 60_000, tokenCeiling: 1_000_000 },
          egressAllowlist: [EGRESS_WILDCARD],
          egressResolve: { [MODEL_HOST]: `127.0.0.1:${String(model.port)}` },
          image: IMAGE,
          runtimesDir,
          maxSteps: 4,
        },
        { canary: 'copse-canary-probe-0123456789', onLog: (line) => logs.push(line) },
      )
      assert.equal(record.result?.stopReason, 'completed', logs.join('\n'))
      const ref = record.carryOut.ref
      assert.ok(ref, record.carryOut.error ?? 'no carry-out ref')
      const probe: unknown = JSON.parse(git(repo, ['show', `${ref}:probe-out.json`]))
      assert.ok(isRecord(probe))
      // The shell child ran as the worker's uid, the case that mattered.
      assert.equal(probe['uid'], 1001)
      // 1. No process's environ or cmdline the child can read holds the token.
      assert.deepEqual(probe['recoveredFrom'], [])
      // 2. Without it the proxy refuses the child; the proxy still refuses
      //    by token, and it never had to be switched off to prove that.
      assert.equal(probe['noAuth'], 'HTTP/1.1 407 Proxy Authentication Required')
      assert.equal(probe['withRecoveredToken'], undefined)
      // 3. The worker verified its own protection rather than assuming it.
      assert.ok(
        logs.some((l) => l.includes('token isolation: on')),
        logs.filter((l) => l.includes('token isolation')).join('\n'),
      )
      // 4. The worker itself still reached the model through the proxy.
      assert.ok(model.requests >= 2)
      assert.ok(record.egress.some((e) => e.event === 'connect'))
    } finally {
      await model.stop()
      rmSync(repo, { recursive: true, force: true })
      rmSync(runtimesDir, { recursive: true, force: true })
    }
  })
})

describe('thread in an Apple container (end to end)', { skip: E2E !== 'apple' }, () => {
  it('runs the same thread in a VM of its own, contained, and brings the work back', async () => {
    assert.equal(await appleContainerAvailable(), true, 'Apple container services required')
    await endToEnd('apple')
  })
})

async function endToEnd(engine: ThreadContainerEngine): Promise<void> {
  const baseImage = process.env['COPSE_WORKER_BASE_IMAGE']
  const buildNetwork = process.env['COPSE_WORKER_BUILD_NETWORK']
  // Each test process owns its bundle: another esbuild writer must not
  // replace it while buildWorkerImage fingerprints and copies it.
  const bundleDir = mkdtempSync(join(tmpdir(), 'copse-thread-worker-e2e-'))
  try {
    const workerBundle = await bundleThreadContainerWorker(join(bundleDir, 'worker.cjs'))
    await buildWorkerImage({
      engine,
      image: IMAGE,
      workerBundle,
      ...(baseImage ? { baseImage } : {}),
      ...(buildNetwork ? { buildNetwork } : {}),
    })
  } finally {
    rmSync(bundleDir, { recursive: true, force: true })
  }

  const model = await startScriptedModelServer([
    // In-guest destruction: the harm gate would prompt; the container tier allows.
    { kind: 'shell', command: 'rm -rf build && mkdir build && echo built > build/out.txt' },
    // An invented external-write tool must not reach any handler.
    { kind: 'tool', name: 'gh_pr_create', args: { title: 'Never create this PR' } },
    // Archive reading remains supported in the actual guest.
    { kind: 'tool', name: 'read_archive', args: { path: 'fixture.zip' } },
    // Outward effect: must be deferred to the review queue, never run.
    { kind: 'shell', command: 'git push origin HEAD' },
    { kind: 'shell', command: 'npm publish' },
    // Host escape: must be refused outright.
    { kind: 'shell', command: 'docker ps' },
    // Ordinary work, committed with the product's own git tool (which runs
    // outside the per-command sandbox, as the agent is told to prefer).
    // Explicit paths: `git add -A` inside a bubblewrap-contained process trips
    // over the sandbox's materialised deny mounts (linux-sandbox-rollout-followups.md §0).
    {
      kind: 'shell',
      command:
        "printf 'edited by the agent\n' >> README.md && git add README.md build/out.txt && git commit -q -m 'agent: edit readme'",
    },
    { kind: 'text', text: 'Finished the task; the push is waiting for your review.' },
  ])
  const repo = await seedRepo()
  const runtimesDir = mkdtempSync(join(tmpdir(), 'copse-tc-runtimes-'))
  const canary = 'copse-canary-e2e-0123456789abcdef'
  const logs: string[] = []
  try {
    const record = await runThreadInContainer(
      {
        engine,
        workspace: repo,
        prompt: 'Build the project, push it, and tidy the README.',
        model: 'scripted',
        hostInference: async (maxOutputTokens) =>
          withCredentialOutputRedaction(
            buildGuestProvider(
              {
                kind: 'openai-compatible',
                model: 'scripted',
                apiKeySlug: 'scripted',
                url: `http://127.0.0.1:${String(model.port)}/v1`,
                label: 'scripted host model',
                local: true,
                includeUsage: true,
                apiStyle: null,
                extraBody: null,
                params: { maxOutputTokens },
              },
              'host-only-provider-secret-123456',
            ),
            ['host-only-provider-secret-123456'],
          ),
        budgets: { wallClockMs: 4 * 60_000, tokenCeiling: 1_000_000 },
        egressAllowlist: [HOST_INFERENCE_TARGET],
        image: IMAGE,
        runtimesDir,
        maxSteps: 12,
      },
      { canary, onLog: (line) => logs.push(line) },
    )
    const result = record.result
    assert.ok(result, `no result written; guest log:\n${logs.join('\n')}`)
    assert.equal(
      result.stopReason,
      'completed',
      `${result.error ?? ''}\nguest log:\n${logs.join('\n')}`,
    )

    // 1. Nobody was asked anything, and the record says Copse ran the loop.
    assert.deepEqual([...result.toolNames].sort(), [...GUEST_ALLOWED_TOOLS].sort())
    const calls = record.transcript.flatMap((message) => message.toolCalls)
    assert.match(calls.find((call) => call.name === 'gh_pr_create')?.result ?? '', /Unknown tool/)
    const archiveResult = calls.find((call) => call.name === 'read_archive')?.result ?? ''
    assert.match(archiveResult, /extracted/)
    assert.match(archiveResult, /inside.txt/)
    assert.equal(result.promptsAttempted, 0)
    assert.equal(result.harness, 'copse')
    // 2. The container declared its containment and the gate used it: the
    //    host's attestation for this engine met the bar, and the guest's
    //    own view of itself agreed with it.
    assert.equal(result.containment.declared, true, result.containment.declineReason ?? '')
    assert.equal(record.attestation.engine, engine)
    assert.equal(record.attestation.isolation, engine === 'apple' ? 'vm' : 'shared-kernel')
    assert.equal(record.attestation.securityProfiles, engine === 'apple' ? 'none' : 'default')
    // 3. The outward effect is in the review queue, and only that.
    assert.equal(result.deferrals.length, 2)
    assert.match(result.deferrals[0]?.title ?? '', /Outward effect/)
    // The refused host escape is in the record too, not only in the log.
    assert.equal(result.denials.length, 1)
    assert.match(result.denials[0]?.reasons.join(' ') ?? '', /docker|host/)
    // 4. The work came back as commits the host can review; HEAD never moved.
    assert.ok(result.commits.some((line) => line.includes('agent: edit readme')))
    const carriedOutRef = record.carryOut.ref
    assert.ok(carriedOutRef, record.carryOut.error ?? 'no carry-out ref')
    assert.equal(record.carryOut.expected, true)
    assert.equal(record.carryOut.error, null)
    assert.match(git(repo, ['show', `${carriedOutRef}:README.md`]), /edited by the agent/)
    assert.match(git(repo, ['show', `${carriedOutRef}:build/out.txt`]), /built/)
    assert.match(git(repo, ['show', `${carriedOutRef}:notes.txt`]), /uncommitted/)
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
    // 5. The model was reached only through the broker, on the port the guest
    //    was told, admitted by the wildcard rule; nothing else was asked for.
    const connects = record.egress.filter((e) => e.event === 'connect')
    assert.ok(connects.length > 0)
    assert.ok(record.egress.every((e) => e.origin === HOST_INFERENCE_TARGET))
    assert.ok(connects.every((e) => e.detail === 'host-authenticated model inference'))
    assert.equal(record.egress.filter((e) => e.event === 'refused').length, 0)
    assert.deepEqual(record.attestation.egressAllowlist, [HOST_INFERENCE_TARGET])
    assert.ok(model.requests >= 5)
    assert.equal(record.credential, 'host')
    const spec = readFileSync(join(runtimesDir, record.runtimeId, 'run.json'), 'utf8')
    assert.ok(!spec.includes('host-only-provider-secret-123456'))
    assert.ok(!spec.includes('127.0.0.1'))
    assert.ok(!spec.includes('apiKeySlug'))
    // 6. The host's secret never entered the guest.
    assert.equal(record.secretCanary.present, false, record.secretCanary.detail)
    const written = readFileSync(join(runtimesDir, record.runtimeId, 'out', 'result.json'), 'utf8')
    // The guest reports the *names* of its environment; the host's canary
    // variable must not be among them, and its value must not appear anywhere.
    assert.ok(!written.includes('COPSE_SECRET_CANARY'))
    assert.ok(!written.includes(canary))
    assert.ok(!written.includes('host-only-provider-secret-123456'))
    // 7. The decision log and queue live in the run's own state, not the host profile.
    assert.ok(
      readFileSync(
        join(
          runtimesDir,
          record.runtimeId,
          'state',
          'workspace',
          `${record.runtimeId}-project`,
          'deferred-approvals.jsonl',
        ),
        'utf8',
      ).includes('shell-outward-effect'),
    )
    // 8. Teardown is idempotent and leaves nothing behind.
    assert.equal(record.teardown, 'removed')
    assert.equal(record.cleanupError, null)
    assert.equal(await teardownRuntime(record.runtimeId, engine), 'already-gone')
    assert.ok(!(await listManagedRuntimes(engine)).some((r) => r.runtimeId === record.runtimeId))
  } finally {
    await model.stop()
    rmSync(repo, { recursive: true, force: true })
    rmSync(runtimesDir, { recursive: true, force: true })
  }
}
