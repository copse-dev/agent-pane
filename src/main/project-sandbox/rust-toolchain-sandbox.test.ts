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

      // Everything else under CARGO_HOME, and the rest of home, stays unreadable.
      // Read files rather than list directories: Linux bubblewrap hides a denied
      // home behind an empty mount, so `ls "$HOME"` succeeds there and shows only
      // the allowed paths, while macOS seatbelt refuses the listing itself.
      let checked = 0
      for (const path of [
        '.cargo/env',
        '.cargo/credentials.toml',
        '.cargo/config.toml',
        '.profile',
        '.bashrc',
        '.zshrc',
      ]) {
        if (!existsSync(join(homedir(), path))) continue
        checked++
        const result = await run(`cat "$HOME/${path}"`)
        assert.notEqual(result.status, 0, `${path} should not be readable\n${result.output}`)
      }
      assert.ok(
        checked > 0,
        'expected at least one home file to probe (rustup writes ~/.cargo/env)',
      )
      const registry = join(homedir(), '.cargo', 'registry')
      if (existsSync(registry)) {
        const result = await run('ls "$HOME/.cargo/registry"/*')
        assert.notEqual(
          result.status,
          0,
          `the registry cache should not be readable\n${result.output}`,
        )
      }
    } finally {
      await SandboxManager.reset()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)
