import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  baseSandboxConfig,
  HOME_INTERPRETER_TOOLCHAIN_DIRS,
  resolveInterpreterToolchainAllowRead,
  workspaceSandboxOverlay,
} from './config.ts'

const credentialFiles = [
  '.npmrc',
  '.yarnrc.yml',
  '.config/pnpm/rc',
  '.bunfig.toml',
  '.config/uv/uv.toml',
  '.pypirc',
  '.config/pip/pip.conf',
  '.netrc',
]

function fakeHome(): { home: string; cleanup: () => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'interpreter-toolchain-')))
  for (const path of credentialFiles) {
    mkdirSync(join(home, path, '..'), { recursive: true })
    writeFileSync(join(home, path), 'token=x\n')
  }
  return {
    home,
    cleanup: (): void => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function tree(path: string): string[] {
  return [path, `${path}/**`]
}

describe('resolveInterpreterToolchainAllowRead', () => {
  it('allows the default Corepack cache, bun, pyenv and uv Python installs when present', () => {
    const { home, cleanup } = fakeHome()
    try {
      const corepack = join(home, '.cache', 'node', 'corepack')
      mkdirSync(corepack, { recursive: true })
      for (const dir of HOME_INTERPRETER_TOOLCHAIN_DIRS)
        mkdirSync(join(home, dir), { recursive: true })

      const allow = resolveInterpreterToolchainAllowRead({}, home)
      assert.deepEqual(allow, [
        ...tree(corepack),
        ...tree(join(home, '.bun', 'bin')),
        ...tree(join(home, '.pyenv', 'versions')),
        ...tree(join(home, '.local', 'share', 'uv', 'python')),
      ])
      // Never the parents that hold credentials or user config.
      for (const parent of [
        '',
        '.bun',
        '.cache',
        '.config',
        '.local',
        '.local/share/uv',
        '.pyenv',
      ]) {
        assert.ok(!allow.includes(join(home, parent)), parent)
      }
      for (const path of credentialFiles) {
        assert.ok(!allow.some((entry) => entry.startsWith(join(home, path))), path)
      }
    } finally {
      cleanup()
    }
  })

  it('adds nothing when no toolchain is installed', () => {
    const { home, cleanup } = fakeHome()
    try {
      assert.deepEqual(resolveInterpreterToolchainAllowRead({}, home), [])
      assert.deepEqual(resolveInterpreterToolchainAllowRead({}, '/nonexistent-home'), [])
    } finally {
      cleanup()
    }
  })

  it('adds only the toolchains that exist', () => {
    const { home, cleanup } = fakeHome()
    try {
      mkdirSync(join(home, '.local', 'share', 'uv', 'python'), { recursive: true })
      assert.deepEqual(
        resolveInterpreterToolchainAllowRead({}, home),
        tree(join(home, '.local', 'share', 'uv', 'python')),
      )
    } finally {
      cleanup()
    }
  })

  it('honours absolute COREPACK_HOME and XDG_CACHE_HOME and ignores relative ones', () => {
    const { home, cleanup } = fakeHome()
    try {
      const moved = join(home, 'corepack-home')
      mkdirSync(moved)
      mkdirSync(join(home, '.cache', 'node', 'corepack'), { recursive: true })
      assert.deepEqual(
        resolveInterpreterToolchainAllowRead({ COREPACK_HOME: moved }, home),
        tree(moved),
      )
      assert.deepEqual(
        resolveInterpreterToolchainAllowRead({ COREPACK_HOME: 'relative' }, home),
        [],
      )

      const xdg = join(home, 'xdg')
      mkdirSync(join(xdg, 'node', 'corepack'), { recursive: true })
      assert.deepEqual(
        resolveInterpreterToolchainAllowRead({ XDG_CACHE_HOME: xdg }, home),
        tree(join(xdg, 'node', 'corepack')),
      )
      assert.deepEqual(
        resolveInterpreterToolchainAllowRead({ XDG_CACHE_HOME: 'relative' }, home),
        tree(join(home, '.cache', 'node', 'corepack')),
      )
    } finally {
      cleanup()
    }
  })

  it('refuses a cache root that is home, contains it, or exposes a credential path', () => {
    const { home, cleanup } = fakeHome()
    try {
      for (const unsafe of [
        home,
        join(home, '..'),
        join(home, '.config'),
        join(home, '.config', 'uv'),
      ]) {
        assert.deepEqual(
          resolveInterpreterToolchainAllowRead({ COREPACK_HOME: unsafe }, home),
          [],
          unsafe,
        )
      }
      mkdirSync(join(home, '.config', 'pip', 'corepack'), { recursive: true })
      assert.deepEqual(
        resolveInterpreterToolchainAllowRead(
          { COREPACK_HOME: join(home, '.config', 'pip', 'corepack') },
          home,
        ),
        [],
      )
      // A symlink is judged by where it points too.
      mkdirSync(join(home, '.bun'))
      symlinkSync(home, join(home, '.bun', 'bin'))
      assert.deepEqual(resolveInterpreterToolchainAllowRead({}, home), [])
    } finally {
      cleanup()
    }
  })

  it('is read-only in the workspace overlay while home stays denied', () => {
    const { filesystem } = workspaceSandboxOverlay('/tmp/project')
    assert.ok(filesystem)
    assert.ok(filesystem.denyRead.includes(homedir()))
    for (const path of resolveInterpreterToolchainAllowRead()) {
      assert.ok(filesystem.allowRead?.includes(path), path)
      assert.ok(!filesystem.allowWrite.includes(path), path)
    }
    for (const path of credentialFiles) {
      assert.ok(!filesystem.allowRead?.includes(join(homedir(), path)), path)
    }
  })
})

const uvPython = join(homedir(), '.local', 'share', 'uv', 'python')
const bun = join(homedir(), '.bun', 'bin', 'bun')

it(
  'starts installed bun and uv Pythons inside the real workspace sandbox, read-only',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async (t) => {
    const commands = [
      ...(existsSync(bun) ? ['"$HOME/.bun/bin/bun" --version'] : []),
      ...(existsSync(uvPython)
        ? ['for p in "$HOME"/.local/share/uv/python/*/bin/python3; do "$p" --version; break; done']
        : []),
    ]
    if (commands.length === 0) {
      t.skip('requires bun under ~/.bun or a uv-managed Python')
      return
    }
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'interpreter-toolchain-sandbox-')))
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
      for (const command of commands) {
        const result = await run(command)
        assert.equal(result.status, 0, `${command}\n${result.output}`)
      }
      const probe = existsSync(bun)
        ? join(homedir(), '.bun', 'bin', '.copse-probe')
        : join(uvPython, '.copse-probe')
      const write = await run(`touch "${probe}"`)
      assert.notEqual(write.status, 0, `toolchain roots must not be writable\n${write.output}`)
      for (const path of credentialFiles) {
        if (!existsSync(join(homedir(), path))) continue
        const result = await run(`cat "$HOME/${path}"`)
        assert.notEqual(result.status, 0, `${path} should not be readable\n${result.output}`)
      }
    } finally {
      await SandboxManager.reset()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)
