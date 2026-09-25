import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig, workspaceSandboxOverlay } from './config.ts'

const cargo = join(homedir(), '.cargo', 'bin', 'cargo')

it(
  'runs the rustup toolchain inside the real workspace sandbox without exposing the rest of CARGO_HOME',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async (t) => {
    if (!existsSync(cargo) || spawnSync(cargo, ['--version']).status !== 0) {
      t.skip('requires a rustup install under ~/.cargo')
      return
    }
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'rust-toolchain-sandbox-')))
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    try {
      const run = async (command: string): Promise<{ status: number | null; output: string }> => {
        const { argv } = await SandboxManager.wrapWithSandboxArgv(
          command,
          '/bin/sh',
          workspaceSandboxOverlay(workspace),
        )
        const [file = '', ...args] = argv
        const result = spawnSync(file, args, { cwd: workspace, encoding: 'utf8' })
        return { status: result.status, output: `${result.stdout}${result.stderr}` }
      }

      // The agent's habitual prefix, then the proxies and the toolchain they select.
      for (const command of [
        'export PATH="$HOME/.cargo/bin:$PATH"; cargo --version',
        'export PATH="$HOME/.cargo/bin:$PATH"; rustc --version',
      ]) {
        const result = await run(command)
        assert.equal(result.status, 0, `${command}\n${result.output}`)
        assert.match(result.output, /^(?:cargo|rustc) \d+\./m)
      }

      // Everything else under CARGO_HOME stays denied: tokens and downloaded sources.
      for (const path of ['credentials.toml', 'config.toml', 'registry']) {
        if (!existsSync(join(homedir(), '.cargo', path))) continue
        const result = await run(`ls "$HOME/.cargo/${path}"`)
        assert.notEqual(result.status, 0, `${path} should not be readable\n${result.output}`)
      }
      const home = await run('ls "$HOME"')
      assert.notEqual(home.status, 0, `the home directory stays denied\n${home.output}`)
    } finally {
      await SandboxManager.reset()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)
