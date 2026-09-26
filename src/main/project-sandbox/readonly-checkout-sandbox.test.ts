import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterSandboxedCommand,
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
  spawnShellInProjectSandbox,
} from './index.ts'
import { withoutCheckoutWrites, workspaceSandboxOverlay } from './config.ts'
import { clearAllowedWorkspaceRootsForTest } from '../services/workspace.ts'
import { setGitAvailableForTest } from '../services/tool-availability.ts'

const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Copse Test',
  GIT_AUTHOR_EMAIL: 'copse@example.invalid',
  GIT_COMMITTER_NAME: 'Copse Test',
  GIT_COMMITTER_EMAIL: 'copse@example.invalid',
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv })
}

async function shell(
  command: string,
  cwd: string,
  readonlyCheckout: boolean,
): Promise<{ output: string; code: number }> {
  const child = await spawnShellInProjectSandbox(command, {
    cwd,
    env: gitEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(readonlyCheckout ? { readonlyCheckout } : {}),
  })
  let output = ''
  child.stdout?.setEncoding('utf-8')
  child.stderr?.setEncoding('utf-8')
  child.stdout?.on('data', (chunk: string) => (output += chunk))
  child.stderr?.on('data', (chunk: string) => (output += chunk))
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => {
      resolve(exitCode ?? 1)
    })
  })
  afterSandboxedCommand()
  return { output, code }
}

describe('withoutCheckoutWrites', () => {
  it('drops every write grant at or under the checkout and keeps the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-readonly-overlay-'))
    try {
      const base = workspaceSandboxOverlay(root)
      const stripped = withoutCheckoutWrites(base, root)
      const writes = stripped.filesystem?.allowWrite ?? []
      const canonicalRoot = (base.filesystem?.allowWrite ?? [])[0]
      assert.ok(canonicalRoot, 'the ordinary profile grants the checkout first')
      assert.ok(
        writes.every((path) => path !== canonicalRoot && !path.startsWith(`${canonicalRoot}/`)),
        `checkout writes survived: ${JSON.stringify(writes)}`,
      )
      // Scratch/tmp writes are what let read-only commands behave normally.
      assert.ok(writes.length > 0, 'non-checkout writes (tmp, scratch) must remain')
      assert.deepEqual(stripped.filesystem?.denyWrite, [])
      // Reads and network policy are the ordinary profile's, unchanged.
      assert.deepEqual(stripped.filesystem.allowRead, base.filesystem?.allowRead)
      assert.deepEqual(stripped.network, base.network)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('read-only checkout shell sandbox', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    await shutdownProjectSandbox()
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('lets a deferred thread read and inspect the checkout but never write it', async (t) => {
    if (process.platform === 'win32') {
      t.skip('project sandbox integration is not enabled on Windows')
      return
    }
    const repo = await mkdtemp(join(tmpdir(), 'copse-readonly-checkout-'))
    cleanups.push(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'tracked.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    // The user's own uncommitted work: a deferred thread must see it, not touch it.
    await writeFile(join(repo, 'tracked.txt'), 'user edit\n')

    setGitAvailableForTest(true)
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }

    // Reads and git inspection behave as they would anywhere else.
    const read = await shell('cat tracked.txt', repo, true)
    assert.equal(read.code, 0, read.output)
    assert.equal(read.output, 'user edit\n')
    const status = await shell('git status --short && git log --oneline -1', repo, true)
    assert.equal(status.code, 0, status.output)
    assert.match(status.output, /M tracked\.txt/)
    assert.match(status.output, /initial/)

    // Scratch space outside the checkout stays writable, so tools that stage
    // through $TMPDIR keep working.
    const scratch = await shell('echo ok > "$TMPDIR/copse-readonly-probe" && echo done', repo, true)
    assert.equal(scratch.code, 0, scratch.output)

    // Every way of writing the checkout is refused, and nothing lands.
    const overwrite = await shell('echo agent > tracked.txt', repo, true)
    assert.notEqual(overwrite.code, 0, 'overwriting a tracked file must fail')
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf-8'), 'user edit\n')
    const create = await shell('touch created-by-agent.txt', repo, true)
    assert.notEqual(create.code, 0, 'creating a file must fail')
    assert.equal(existsSync(join(repo, 'created-by-agent.txt')), false)
    const commit = await shell('git commit -qam agent', repo, true)
    assert.notEqual(commit.code, 0, 'committing must fail')
    assert.equal(git(repo, ['rev-list', '--count', 'HEAD']).trim(), '1')

    // Positive control: the same write succeeds in the ordinary profile, so the
    // refusals above come from the read-only checkout, not a broken sandbox.
    const control = await shell('touch created-by-control.txt', repo, false)
    assert.equal(control.code, 0, control.output)
    assert.equal(existsSync(join(repo, 'created-by-control.txt')), true)
  })

  it('refuses to run a read-only checkout command outside the sandbox', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'copse-readonly-unsandboxed-'))
    cleanups.push(repo)
    await assert.rejects(
      spawnShellInProjectSandbox('true', { cwd: repo, unsandboxed: true, readonlyCheckout: true }),
      /cannot run commands outside the project sandbox/,
    )
  })
})
