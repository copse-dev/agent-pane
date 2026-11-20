import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../../project-sandbox/index.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'
import { spawnAcpAgentProcess } from './acp-client.ts'

// Cursor's own installer puts `cursor-agent` in `~/.local/bin` as a symlink into
// `~/.local/share/cursor-agent`. The agent sandbox denies home except the agent's
// own dirs, so the sandboxed shell could not even see the PATH entry: every
// Cursor probe and turn failed with "cursor-agent: command not found" (exit 127)
// although onboarding had found it installed.
describe('a sandboxed ACP agent installed as a symlink in a home bin directory', () => {
  const cleanups: string[] = []
  after(async () => {
    await shutdownProjectSandbox()
    for (const path of cleanups) await rm(path, { recursive: true, force: true })
  })

  it('starts by its bare name, and its bin directory stays unreadable and unwritable', async (t) => {
    if (process.platform === 'win32') {
      t.skip('the project sandbox does not run on Windows')
      return
    }
    // A stand-in home layout: bin/fake-agent -> share/fake-agent/fake-agent.
    const root = await mkdtemp(join(homedir(), '.copse-agent-exec-test-'))
    cleanups.push(root)
    const bin = join(root, 'bin')
    const share = join(root, 'share', 'fake-agent')
    const workspace = join(root, 'workspace')
    await Promise.all([mkdir(bin), mkdir(share, { recursive: true }), mkdir(workspace)])
    const target = join(share, 'fake-agent')
    // It runs its arguments as its own child, as an agent runs tools.
    await writeFile(target, '#!/bin/sh\necho agent-started\nexec "$@"\n')
    await chmod(target, 0o755)
    await symlink(target, join(bin, 'fake-agent'))
    await writeFile(join(bin, 'other-tool'), 'not for the agent\n')

    setGitAvailableForTest(true)
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('project sandbox unavailable')
      return
    }

    const run = async (
      args: string[],
      pathEntry = bin,
    ): Promise<{ code: number | null; output: string }> => {
      const child = await spawnAcpAgentProcess({
        command: 'fake-agent',
        args,
        cwd: workspace,
        env: { PATH: `${pathEntry}:/usr/bin:/bin` },
        // Like Cursor's entry: the install tree is the agent's, its bin dir is not.
        sandbox: { allowedDomains: [], homeDirs: [relative(homedir(), share)] },
      })
      child.stdin?.end()
      let output = ''
      child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
      const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
      return { code, output }
    }

    const started = await run(['true'])
    assert.equal(started.code, 0, started.output)
    assert.equal(started.output.trim(), 'agent-started')

    // The wrapper shell resolves a relative PATH entry from the agent's cwd, not
    // Copse's, so the grant must name the executable found from there.
    const fromCwd = await run(['true'], '../bin')
    assert.equal(fromCwd.code, 0, fromCwd.output)
    assert.equal(fromCwd.output.trim(), 'agent-started')

    // Finding the executable happens in Copse before the sandbox exists, so it
    // must not run anything from the agent's PATH: a workspace-relative entry
    // can put a `which` there that would otherwise run unconfined.
    const marker = join(root, 'planted-which-ran')
    await mkdir(join(workspace, 'bin'))
    await writeFile(join(workspace, 'bin', 'which'), `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(join(workspace, 'bin', 'which'), 0o755)
    const plantedWhich = await run(['true'], `bin:${bin}`)
    assert.equal(plantedWhich.code, 0, plantedWhich.output)
    assert.equal(existsSync(marker), false)

    // The grant is the one executable, read-only: the rest of its directory
    // stays unreadable, and nothing can be planted beside it.
    const neighbour = await run(['cat', join(bin, 'other-tool')])
    assert.notEqual(neighbour.code, 0)
    assert.doesNotMatch(neighbour.output, /not for the agent/)
    // macOS refuses the listing outright; bubblewrap mounts the one file into an
    // otherwise empty directory, so `ls` succeeds and shows only that file.
    const listing = await run(['ls', bin])
    assert.doesNotMatch(listing.output, /other-tool/)
    // macOS refuses the write; under bubblewrap it lands in that throwaway
    // directory inside the sandbox. Either way nothing reaches the real one.
    const planted = join(bin, 'planted')
    await run(['touch', planted])
    assert.equal(existsSync(planted), false)
  })
})
