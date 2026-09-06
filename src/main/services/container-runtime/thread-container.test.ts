import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  buildAttestation,
  waitForContainer,
  workerBuildFingerprint,
  containerName,
  createSnapshotCommit,
  dockerRunArgs,
  egressSocketDir,
  egressSocketName,
  fetchCarryOut,
  parseEgressOrigin,
  providerOrigin,
  secretCanaryCheck,
  WORKER_UID,
  writeCarryInBundle,
  type DockerRunInput,
} from './thread-container.ts'
import { containerAttestationShortfall } from '../security/runtime-containment.ts'

function input(overrides: Partial<DockerRunInput> = {}): DockerRunInput {
  return {
    runtimeId: 'run-test',
    image: 'copse-worker:test',
    runDir: '/tmp/copse-runs/run-test',
    egressDir: '/tmp/copse-egress-run-test',
    egress: [{ host: 'model.copse.internal', port: 8080 }],
    apiKeyEnv: null,
    memoryLimit: '4g',
    pidsLimit: 512,
    cpus: 2,
    ...overrides,
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copse-tc-repo-'))
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['config', 'user.email', 'test@copse.invalid'])
  writeFileSync(join(dir, 'README.md'), '# hello\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'init'])
  return dir
}

describe('egress origins', () => {
  it('parses host:port and rejects anything else', () => {
    assert.deepEqual(parseEgressOrigin('api.example.com:443'), {
      host: 'api.example.com',
      port: 443,
    })
    assert.throws(() => parseEgressOrigin('api.example.com'))
    assert.throws(() => parseEgressOrigin('http://x:1'))
    assert.throws(() => parseEgressOrigin('x:70000'))
  })

  it('derives the origin a provider URL needs', () => {
    assert.deepEqual(providerOrigin('http://model.copse.internal:8080/v1'), {
      host: 'model.copse.internal',
      port: 8080,
    })
    assert.deepEqual(providerOrigin('https://api.openai.com/v1'), {
      host: 'api.openai.com',
      port: 443,
    })
  })

  it('names sockets safely', () => {
    // No separator, no traversal, no hostname — whatever the origin looks like.
    for (const host of ['a.b-c', 'we/ird', '../../etc', 'x'.repeat(300)]) {
      const name = egressSocketName({ host, port: 443 })
      assert.match(name, /^[0-9a-f]{10}\.sock$/)
    }
    // Distinct origins get distinct sockets, including same host, other port.
    const names = new Set(
      [
        { host: 'openrouter.ai', port: 443 },
        { host: 'api.openai.com', port: 443 },
        { host: 'openrouter.ai', port: 8443 },
      ].map(egressSocketName),
    )
    assert.equal(names.size, 3)
  })

  it('keeps the socket path inside sun_path on a macOS temp root', () => {
    // The overflow this replaced, measured on the reported failure: a per-user
    // macOS temp root, the full runtime id in the directory and the hostname in
    // the file name came to 104 bytes against a 104-byte cap.
    const macTmp = '/var/folders/r5/qll_28695_q_2qr2kk7lv5gm0000gn/T'
    const dir = join(macTmp, basename(egressSocketDir('run-mtpvs161-9a6506')))
    const path = join(dir, egressSocketName({ host: 'openrouter.ai', port: 443 }))
    assert.ok(Buffer.byteLength(path) <= 100, `${path} is ${String(Buffer.byteLength(path))} bytes`)
    // And it stays inside the cap for an origin no one budgeted for.
    const long = join(
      dir,
      egressSocketName({ host: `${'gateway.'.repeat(20)}internal`, port: 443 }),
    )
    assert.ok(Buffer.byteLength(long) <= 100)
  })
})

describe('dockerRunArgs', () => {
  it('carries every hardening flag the attestation claims', () => {
    const args = dockerRunArgs(input())
    for (const flag of [
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--network=none',
      `--user=${String(WORKER_UID)}:${String(WORKER_UID)}`,
      '--pids-limit=512',
      '--memory=4g',
    ]) {
      assert.ok(args.includes(flag), `missing ${flag}`)
    }
    assert.equal(args.at(-1), 'copse-worker:test')
    assert.equal(args[args.indexOf('--name') + 1], containerName('run-test'))
  })

  it('binds each allowed origin to loopback and nothing else', () => {
    const args = dockerRunArgs(input())
    assert.ok(args.includes('--add-host'))
    assert.equal(args[args.indexOf('--add-host') + 1], 'model.copse.internal:127.0.0.1')
    assert.ok(args.includes('--sysctl=net.ipv4.ip_unprivileged_port_start=0'))
    const none = dockerRunArgs(input({ egress: [] }))
    assert.ok(!none.includes('--add-host'))
    assert.ok(!none.some((a) => a.startsWith('--sysctl')))
  })

  it('mounts only the run directory, and passes the key by name of the variable only', () => {
    const args = dockerRunArgs(input({ apiKeyEnv: 'COPSE_RUN_KEY' }))
    const volumes = args.filter((_, i) => args[i - 1] === '--volume')
    assert.equal(volumes.length, 4)
    for (const volume of volumes) {
      assert.ok(
        volume.startsWith('/tmp/copse-runs/run-test') ||
          volume.startsWith('/tmp/copse-egress-run-test'),
        volume,
      )
    }
    assert.ok(args.includes('COPSE_RUN_KEY'))
    assert.ok(!args.some((a) => a.includes('COPSE_RUN_KEY=')))
  })

  it('produces an attestation that meets the containment bar', () => {
    const attestation = buildAttestation(input(), 'sha256:abc')
    assert.equal(containerAttestationShortfall(attestation), null)
    assert.equal(attestation.network, 'brokered')
    assert.deepEqual(attestation.egressAllowlist, ['model.copse.internal:8080'])
    assert.equal(buildAttestation(input({ egress: [] }), undefined).network, 'none')
  })
})

describe('carry-in / carry-out over git bundles', () => {
  it('snapshots a dirty tree without touching HEAD and round-trips commits back', () => {
    const repo = initRepo()
    const guest = mkdtempSync(join(tmpdir(), 'copse-tc-guest-'))
    try {
      writeFileSync(join(repo, 'wip.txt'), 'uncommitted\n')
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      const snapshot = createSnapshotCommit(repo)
      assert.equal(snapshot.dirty, true)
      assert.notEqual(snapshot.sha, headBefore)
      assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD must not move')
      assert.equal(git(repo, ['status', '--porcelain']).includes('wip.txt'), true)

      const bundle = join(guest, 'carry-in.bundle')
      const carried = writeCarryInBundle(repo, 'run-x', bundle)
      // The bundle carries the same snapshot a fresh call would make. Compare
      // trees, not commit shas: a commit sha folds in the committer timestamp
      // at one-second granularity, so asserting sha equality across two calls
      // passes or fails on whether they land either side of a second — which is
      // exactly how this failed in CI having passed locally for days.
      assert.equal(
        git(repo, ['rev-parse', `${carried.sha}^{tree}`]),
        git(repo, ['rev-parse', `${createSnapshotCommit(repo).sha}^{tree}`]),
        'the bundled snapshot must have the same tree as a fresh snapshot',
      )
      assert.equal(git(repo, ['for-each-ref', 'refs/copse/carry-in/']), '', 'temp ref removed')

      // What the guest does.
      const work = join(guest, 'repo')
      git(guest, ['init', '--quiet', '--initial-branch=carry-in', work])
      git(work, ['config', 'user.name', 'guest'])
      git(work, ['config', 'user.email', 'guest@copse.invalid'])
      git(work, ['fetch', '--quiet', bundle, `${carried.ref}:refs/heads/work`])
      git(work, ['checkout', '--quiet', 'work'])
      assert.equal(git(work, ['show', 'HEAD:wip.txt']), 'uncommitted')
      writeFileSync(join(work, 'done.txt'), 'guest work\n')
      git(work, ['add', '-A'])
      git(work, ['commit', '--quiet', '-m', 'guest: did the thing'])
      const out = join(guest, 'carry-out.bundle')
      git(work, ['bundle', 'create', out, `${carried.sha}..work`])

      const ref = fetchCarryOut(repo, 'run-x', out)
      assert.equal(ref, 'refs/copse/runs/run-x')
      assert.equal(git(repo, ['show', `${ref}:done.txt`]), 'guest work')
      assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'the host never moves HEAD')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(guest, { recursive: true, force: true })
    }
  })
})

describe('waitForContainer', () => {
  /** A wait that never closes: the container is gone but `docker wait` hangs. */
  function hungWait(): { output: Promise<string>; cancel: () => void } {
    return { output: new Promise<string>(() => {}), cancel: (): void => {} }
  }

  it('settles on the ordinary exit', async () => {
    const outcome = await waitForContainer('c', 10_000, {
      wait: () => ({ output: Promise.resolve('137\n'), cancel: (): void => {} }),
      stop: () => Promise.reject(new Error('must not be called')),
    })
    assert.deepEqual(outcome, { exit: 137, timedOut: false, cleanupError: null })
  })

  it('settles at the deadline even when stop fails and the wait never closes', async () => {
    let cancelled = false
    const outcome = await waitForContainer('c', 5, {
      wait: () => ({
        output: new Promise<string>(() => {}),
        cancel: (): void => {
          cancelled = true
        },
      }),
      stop: () => Promise.reject(new Error('daemon refused: container is not running')),
      settleAfterStopMs: 5,
    })
    assert.equal(outcome.timedOut, true)
    assert.equal(outcome.exit, null)
    // The failure is reported, not swallowed: the container may still be up.
    assert.match(outcome.cleanupError ?? '', /daemon refused/)
    assert.equal(cancelled, true, 'the abandoned wait must not be left running')
  })

  it('settles at the deadline when a successful stop never settles the wait', async () => {
    const outcome = await waitForContainer('c', 5, {
      wait: hungWait,
      stop: () => Promise.resolve(),
      settleAfterStopMs: 5,
    })
    assert.equal(outcome.timedOut, true)
    assert.match(outcome.cleanupError ?? '', /did not exit/)
  })

  it('reports a wait that cannot start at all', async () => {
    const outcome = await waitForContainer('c', 10_000, {
      wait: () => ({
        output: Promise.reject(new Error('spawn docker ENOENT')),
        cancel: (): void => {},
      }),
      stop: () => Promise.reject(new Error('must not be called')),
    })
    assert.match(outcome.cleanupError ?? '', /ENOENT/)
    assert.equal(outcome.timedOut, false)
  })
})

describe('workerBuildFingerprint', () => {
  it('changes when the shipped worker bundle changes, and is stable otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-fingerprint-'))
    try {
      const bundle = join(dir, 'worker.cjs')
      writeFileSync(bundle, 'console.log("v1")')
      const first = workerBuildFingerprint({ workerBundle: bundle })
      assert.equal(workerBuildFingerprint({ workerBundle: bundle }), first)
      // An app upgrade ships a different guest: the image must not be reused.
      writeFileSync(bundle, 'console.log("v2")')
      assert.notEqual(workerBuildFingerprint({ workerBundle: bundle }), first)
      // So must a different base image, which changes the guest's toolchain.
      assert.notEqual(
        workerBuildFingerprint({ workerBundle: bundle, baseImage: 'other:latest' }),
        workerBuildFingerprint({ workerBundle: bundle }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('secretCanaryCheck', () => {
  it('finds the canary in any host-owned surface and reports absence otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-tc-canary-'))
    try {
      writeFileSync(join(dir, 'run.json'), '{"prompt":"hi"}')
      assert.equal(secretCanaryCheck(dir, 'canary-123').present, false)
      writeFileSync(join(dir, 'run.json'), '{"prompt":"canary-123"}')
      assert.equal(secretCanaryCheck(dir, 'canary-123').present, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
