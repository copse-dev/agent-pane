import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerAcpAgentSpecs } from '@shared/container-acp-agents.ts'
import { WORKER_DOCKERFILE, WORKER_ENTRYPOINT_SH } from './worker-image-files.ts'
import {
  buildAttestation,
  waitForContainer,
  workerBuildFingerprint,
  containerName,
  workspaceVolumeName,
  adoptCarryOut,
  createSnapshotCommit,
  dockerRunArgs,
  fetchCarryOut,
  loadCarryOutForAdoption,
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
    egress: [{ host: 'model.copse.internal', wildcard: false, port: 8080 }],
    egressToken: 'test-run-token',
    sharedStore: false,
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
    // The container is the sandbox (A7): nothing inside it needs the
    // unconfined profiles a nested bubblewrap did, so the defaults stay on.
    assert.ok(!args.some((a) => a.includes('unconfined')))
  })

  it('binds each allowed origin to loopback and nothing else', () => {
    const args = dockerRunArgs(input())
    // No per-origin plumbing: no host aliases, no unprivileged-port sysctl.
    // Every client in the guest is pointed at the loopback proxy instead, and
    // the proxy at the link over the container's own stdio.
    assert.ok(!args.includes('--add-host'))
    assert.ok(!args.some((a) => a.startsWith('--sysctl')))
    const env = (name: string): string | undefined =>
      args
        .find((a, i) => args[i - 1] === '--env' && a.startsWith(`${name}=`))
        ?.slice(name.length + 1)
    assert.equal(env('COPSE_EGRESS'), 'stdio')
    assert.equal(args[0], 'create')
    assert.ok(args.includes('--interactive'), 'stdin is the link, so it must stay open')
    // The proxy URL carries the run's token (A7); the worker blanks it after
    // Node's dispatcher has read it, so children never see it.
    const proxy = 'http://run:test-run-token@127.0.0.1:3128'
    assert.equal(env('HTTPS_PROXY'), proxy)
    assert.equal(env('HTTP_PROXY'), proxy)
    assert.equal(env('https_proxy'), proxy)
    assert.equal(env('COPSE_EGRESS_TOKEN'), 'test-run-token')
    assert.equal(env('NO_PROXY'), '127.0.0.1,localhost,::1')
    assert.equal(env('NODE_USE_ENV_PROXY'), '1')
    assert.equal(env('NODE_OPTIONS'), '--disable-warning=UNDICI-EHPA')
    const none = dockerRunArgs(input({ egress: [], egressToken: null }))
    assert.equal(
      none.some((a) => a.startsWith('HTTPS_PROXY=') || a.startsWith('COPSE_EGRESS=')),
      false,
      'a run with no egress gets no proxy and no link',
    )
    assert.ok(!none.some((a) => a.startsWith('--sysctl')))
  })

  it('mounts only the run directory, and passes the key by name of the variable only', () => {
    const args = dockerRunArgs(input({ apiKeyEnv: 'COPSE_RUN_KEY' }))
    const volumes = args.filter((_, i) => args[i - 1] === '--volume')
    assert.equal(volumes.length, 3)
    for (const volume of volumes) {
      assert.ok(volume.startsWith('/tmp/copse-runs/run-test'), volume)
    }
    // The workspace is a per-run named volume on the daemon's disk (A9), not
    // a tmpfs charged to the memory limit and not a host path.
    const mounts = args.filter((a) => a.startsWith('--mount='))
    assert.deepEqual(mounts, [
      `--mount=type=volume,source=${workspaceVolumeName('run-test')},target=/workspace,volume-nocopy=false`,
    ])
    // An installing run also mounts the host's shared pnpm store, nested in
    // the fresh workspace (A12); one that does not install never sees it.
    const installing = dockerRunArgs(input({ apiKeyEnv: 'COPSE_RUN_KEY', sharedStore: true }))
    assert.ok(
      installing.includes(
        '--mount=type=volume,source=copse-pnpm-store,target=/workspace/.pnpm-store,volume-nocopy=false',
      ),
    )
    assert.ok(!args.some((a) => a.startsWith('--tmpfs=/workspace')))
    // The home is on the volume as well: no tmpfs for it, and HOME points there.
    assert.ok(!args.some((a) => a.startsWith('--tmpfs=/home')))
    // /tmp stays a tmpfs, and an executable one: Docker's default is noexec.
    const tmp = args.find((a) => a.startsWith('--tmpfs=/tmp:'))
    assert.ok(tmp !== undefined, 'no /tmp tmpfs')
    assert.match(tmp.slice('--tmpfs=/tmp:'.length), /(^|,)exec(,|$)/)
    assert.ok(args.includes('HOME=/workspace/home'))
    // Postinstall binary downloads are switched off for every process in the
    // guest: their hosts are never admitted.
    assert.ok(!args.includes('ELECTRON_SKIP_BINARY_DOWNLOAD=1'), 'Electron comes from GitHub (A11)')
    assert.ok(args.includes('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1'))
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

describe('writeCarryInBundle from a ref', () => {
  it("carries in the ref's commit, not the working tree, and calls it clean", () => {
    const repo = initRepo()
    try {
      const base = git(repo, ['rev-parse', 'HEAD'])
      git(repo, ['checkout', '--quiet', '--detach', base])
      writeFileSync(join(repo, 'guest.txt'), 'from the run\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '--quiet', '-m', 'guest: work'])
      const runHead = git(repo, ['rev-parse', 'HEAD'])
      git(repo, ['update-ref', 'refs/copse/runs/run-a', runHead])
      git(repo, ['checkout', '--quiet', 'main'])
      writeFileSync(join(repo, 'wip.txt'), 'uncommitted on the desktop\n')
      const bundle = join(repo, 'carry-in.bundle')
      const carried = writeCarryInBundle(repo, 'run-b', bundle, 'refs/copse/runs/run-a')
      assert.equal(carried.sha, runHead)
      assert.equal(carried.dirty, false)
      assert.equal(git(repo, ['bundle', 'list-heads', bundle]).includes(runHead), true)
      assert.throws(
        () => writeCarryInBundle(repo, 'run-c', bundle, 'refs/copse/runs/missing'),
        /refs\/copse\/runs\/missing/,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('adoptCarryOut', () => {
  /** A run's commits on the carry-out ref, on top of a base, as fetchCarryOut leaves them. */
  function runOnRef(repo: string, base: string, ref: string, files: string[]): void {
    git(repo, ['checkout', '--quiet', '--detach', base])
    for (const file of files) {
      writeFileSync(join(repo, file), `${file}\n`)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '--quiet', '-m', `guest: add ${file}`])
    }
    git(repo, ['update-ref', ref, 'HEAD'])
    git(repo, ['checkout', '--quiet', 'main'])
  }

  it("cherry-picks the guest's commits onto HEAD once, and counts them the second time", () => {
    const repo = initRepo()
    try {
      const base = git(repo, ['rev-parse', 'HEAD'])
      runOnRef(repo, base, 'refs/copse/runs/run-a', ['one.txt', 'two.txt'])
      // The user moved on in the meantime: the pick lands on the new HEAD.
      writeFileSync(join(repo, 'theirs.txt'), 'theirs\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '--quiet', '-m', 'user: meanwhile'])
      const first = adoptCarryOut(repo, 'refs/copse/runs/run-a', base)
      assert.deepEqual(
        first.applied.map((line) => line.slice(line.indexOf(' ') + 1)),
        ['guest: add one.txt', 'guest: add two.txt'],
      )
      assert.equal(first.alreadyApplied, 0)
      assert.equal(git(repo, ['show', 'HEAD:two.txt']), 'two.txt')
      assert.equal(git(repo, ['show', 'HEAD~2:theirs.txt']), 'theirs')
      const second = adoptCarryOut(repo, 'refs/copse/runs/run-a', base)
      assert.deepEqual(second, { applied: [], alreadyApplied: 2 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses a dirty checkout and leaves a conflicting pick aborted', () => {
    const repo = initRepo()
    try {
      const base = git(repo, ['rev-parse', 'HEAD'])
      runOnRef(repo, base, 'refs/copse/runs/run-b', ['README.md'])
      writeFileSync(join(repo, 'README.md'), '# edited\n')
      assert.throws(() => adoptCarryOut(repo, 'refs/copse/runs/run-b', base), /uncommitted changes/)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '--quiet', '-m', 'user: edited the readme'])
      assert.throws(
        () => adoptCarryOut(repo, 'refs/copse/runs/run-b', base),
        /Could not apply the run's commits/,
      )
      assert.equal(git(repo, ['status', '--porcelain']), '', 'the pick was aborted')
      assert.equal(git(repo, ['show', 'HEAD:README.md']), '# edited')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads what a follow-up needs from a record on disk, and nothing from a bad id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-tc-records-'))
    try {
      execFileSync('mkdir', ['-p', join(dir, 'run-1')])
      writeFileSync(
        join(dir, 'run-1', 'record.json'),
        JSON.stringify({
          threadId: 't1',
          carryIn: { sha: 'abc', dirty: false },
          carryOut: { expected: true, ref: 'refs/copse/runs/run-1', error: null },
        }),
      )
      assert.deepEqual(loadCarryOutForAdoption('run-1', dir), {
        threadId: 't1',
        ref: 'refs/copse/runs/run-1',
        base: 'abc',
      })
      assert.equal(loadCarryOutForAdoption('run-2', dir), null)
      assert.equal(loadCarryOutForAdoption('../run-1', dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
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
      // And the agents baked in: a version bump is a different guest too. The
      // default is the key-capable catalogue set, so an explicit empty list and
      // an explicit older pin both differ from it.
      const current = workerBuildFingerprint({ workerBundle: bundle })
      assert.equal(
        workerBuildFingerprint({ workerBundle: bundle, acpAgents: containerAcpAgentSpecs() }),
        current,
      )
      assert.notEqual(workerBuildFingerprint({ workerBundle: bundle, acpAgents: [] }), current)
      assert.notEqual(
        workerBuildFingerprint({
          workerBundle: bundle,
          acpAgents: containerAcpAgentSpecs(),
          pnpmVersion: '0.0.1',
        }),
        current,
        'the baked pnpm is part of the image',
      )
      assert.notEqual(
        workerBuildFingerprint({
          workerBundle: bundle,
          acpAgents: ['@agentclientprotocol/claude-agent-acp@0.0.1'],
        }),
        current,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('WORKER_DOCKERFILE', () => {
  it('bakes the agents from a build argument, globally, before dropping to the worker user', () => {
    const lines = WORKER_DOCKERFILE.split('\n')
    const arg = lines.findIndex((line) => line.startsWith('ARG ACP_AGENTS='))
    const install = lines.findIndex((line) => /npm install -g .*\$\{ACP_AGENTS\}/.test(line))
    const user = lines.findIndex((line) => line.startsWith('USER '))
    assert.ok(arg !== -1 && install !== -1 && user !== -1)
    assert.ok(arg < install && install < user)
    // An empty argument skips the layer rather than running `npm install -g`
    // with nothing, so a build without agents stays a build.
    assert.match(lines[install] ?? '', /if \[ -n "\$\{ACP_AGENTS\}" \]/)
    // The project's package manager is baked the same way (A9), on a Node 24
    // base, which is what the projects a run carries in expect.
    const pnpm = lines.findIndex((line) => /npm install -g .*"pnpm@\$\{PNPM_VERSION\}"/.test(line))
    assert.ok(pnpm !== -1 && pnpm < user)
    assert.ok(lines.some((line) => line === 'ARG BASE_IMAGE=node:24-trixie-slim'))
    // node-gyp's toolchain, so a project's native modules build in the guest,
    // and a virtual display with Electron's libraries, so an e2e suite runs (A11).
    for (const tool of [
      'python3',
      'make',
      'g++',
      'xvfb',
      'xauth',
      'libgtk-3-0t64',
      'libnss3',
      'libgbm1',
    ]) {
      assert.ok(
        new RegExp(`^\\s+${tool.replace('+', '\\+')} \\\\$`, 'm').test(WORKER_DOCKERFILE),
        tool,
      )
    }
    // The container is the sandbox (A7): no bubblewrap, and so no socat for
    // the runtime's bridge; the entrypoint starts nothing either.
    // The apt list is the check, not the prose: the Dockerfile's own comment
    // says why they are absent.
    assert.ok(!/^\s+(?:bubblewrap|socat) \\$/m.test(WORKER_DOCKERFILE))
    assert.ok(!WORKER_ENTRYPOINT_SH.includes('socat'))
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
