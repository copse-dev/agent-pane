import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  abortScratchFetchesForQuit,
  fetchThroughScratchRepository,
  originBranchRef,
} from './default-branch-fetch.ts'
import { runWorktreeGit } from './worktree-manager.ts'

// Aborting is permanent for the process, so these cases live in their own file.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    },
  })
}

const execFileAsync = promisify(execFile)

/**
 * Command lines still mentioning `needle`, polled until none are left or a
 * short kill grace has passed. Each `ps` run is its own wait, so the loop
 * needs no timer.
 */
async function processesNamingAfterGrace(needle: string): Promise<string[]> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'args='])
    const survivors = stdout.split('\n').filter((line) => line.includes(needle))
    if (survivors.length === 0 || Date.now() > deadline) return survivors
  }
}

describe('abortScratchFetchesForQuit', () => {
  const cleanups: string[] = []
  let server: Server | undefined

  after(async () => {
    server?.closeAllConnections()
    server?.close()
    for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true })
  })

  it('kills an in-flight host fetch, removes its scratch and refuses later fetches', async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-default-branch-quit-')))
    cleanups.push(temp)
    const project = join(temp, 'project')
    git(temp, ['init', '-q', '-b', 'main', project])
    await writeFile(join(project, 'README.md'), 'initial\n')
    git(project, ['add', '.'])
    git(project, ['commit', '-q', '-m', 'initial'])

    // A remote that accepts the request and never answers, like a slow download.
    let requested!: () => void
    const firstRequest = new Promise<void>((resolve) => {
      requested = resolve
    })
    server = createServer(() => {
      requested()
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const { port } = address
    const url = `http://127.0.0.1:${String(port)}/repo.git`
    const scratch = join(temp, 'scratch.git')

    const fetching = fetchThroughScratchRepository({
      projectRoot: project,
      url,
      refs: [originBranchRef('main')],
      scratch,
      projectGit: runWorktreeGit,
      gitAuth: 'noninteractive',
    })
    await firstRequest
    assert.equal(existsSync(scratch), true)

    const started = Date.now()
    await abortScratchFetchesForQuit()
    assert.ok(Date.now() - started < 4_000, 'abort waited for the fetch timeout')
    const outcome = await fetching.then(
      (result) => result.code,
      () => 'rejected',
    )
    assert.notEqual(outcome, 0)
    assert.equal(existsSync(scratch), false)
    // The whole group goes, not only the `git fetch` leader: its remote
    // helper must not keep downloading after quit (#4407).
    assert.deepEqual(await processesNamingAfterGrace(url), [])

    const later = await fetchThroughScratchRepository({
      projectRoot: project,
      url,
      refs: [originBranchRef('main')],
      scratch,
      projectGit: runWorktreeGit,
    })
    assert.notEqual(later.code, 0)
    assert.match(later.stderr, /quitting/)
  })
})
