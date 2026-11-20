import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os, { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import {
  baseSandboxConfig,
  ensureWorkspaceTmpDir,
  workspaceSandboxOverlay,
  withoutCheckoutWrites,
} from './config.ts'
import { formatArgvForShell, resolveSandboxShellExecutable } from './sandbox-argv.ts'
import { sandboxTmpDirFor, withSandboxTmpEnv, withSandboxWrapTmpDir } from './tmp-env.ts'

// A denial must be a real kernel permission error. Missing fixtures, a broken
// executable, sandbox startup failures and timeouts must never look like proof.
const denialProbe = `
  const fs = require('node:fs')
  const [operation, target] = process.argv.slice(1)
  try {
    if (operation === 'read') fs.readFileSync(target)
    else if (operation === 'write') fs.writeFileSync(target, 'unexpected write\\n')
    else fs.unlinkSync(target)
    throw new Error('sandbox unexpectedly allowed ' + operation + ': ' + target)
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error
    process.stdout.write('denied\\n')
  }
`

type Fixture = {
  root: string
  home: string
  workspace: string
  node: string
  toolchainData: string
  workspaceData: string
  scratch: string
  credentials: string[]
  sibling: string
  path: string
}

async function withFixture(
  t: TestContext,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copse node seatbelt ')))
  const home = join(root, 'home')
  const workspace = join(home, 'projects', 'project')
  const version = join(home, '.nvm', 'versions', 'node', process.version)
  const node = join(version, 'bin', 'node')
  const toolchainData = join(version, 'lib', 'node_modules', 'fixture.txt')
  const workspaceData = join(workspace, 'tracked.txt')
  const profile = join(home, 'profile')
  const credentials = [
    join(home, '.ssh', 'id_ed25519'),
    join(home, '.codex', 'auth.json'),
    join(home, 'relocated-auth', 'session.data'),
    join(profile, 'user-data', 'config.json'),
  ]
  const sibling = join(home, 'unrelated', 'private.txt')
  const env = {
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    COPSE_DIR: profile,
    COPSE_PANEL_USER_DATA: join(profile, 'user-data'),
    COPSE_WORKSPACE_DIR: join(profile, 'workspace'),
    COPSE_WORKTREES_DIR: join(profile, 'worktrees'),
    AWS_SHARED_CREDENTIALS_FILE: credentials[2],
    CLAUDE_CODE_TMPDIR: '',
    CLAUDE_TMPDIR: undefined,
  }
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  const homeMock = t.mock.method(os, 'homedir', () => home)
  syncBuiltinESMExports()
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    for (const path of [node, toolchainData, workspaceData, sibling, ...credentials]) {
      mkdirSync(dirname(path), { recursive: true })
    }
    // Use the actual setup-node executable without modifying its Mach-O bytes
    // or signature. A shell script named node would not exercise Node's runtime.
    const sourceNode = realpathSync(process.execPath)
    copyFileSync(sourceNode, node)
    chmodSync(node, 0o755)
    const digest = (file: string): string =>
      createHash('sha256').update(readFileSync(file)).digest('hex')
    assert.equal(digest(node), digest(sourceNode))
    writeFileSync(toolchainData, 'toolchain data\n')
    writeFileSync(workspaceData, 'workspace data\n')
    writeFileSync(sibling, 'unrelated private data\n')
    for (const path of credentials) {
      // Executable mode means that rejecting non-executable files alone cannot
      // satisfy the credential-alias contract. These files are never executed.
      writeFileSync(path, 'synthetic credential\n', { mode: 0o755 })
    }

    // Outside the sandbox every fixture exists and is readable. Denial checks
    // below therefore cannot pass merely because a path was never created.
    for (const path of credentials)
      assert.equal(readFileSync(path, 'utf8'), 'synthetic credential\n')
    const scratch = ensureWorkspaceTmpDir()
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    await run({
      root,
      home,
      workspace,
      node,
      toolchainData,
      workspaceData,
      scratch,
      credentials,
      sibling,
      path: env.PATH,
    })
  } finally {
    try {
      await SandboxManager.reset()
    } finally {
      homeMock.mock.restore()
      syncBuiltinESMExports()
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function nodeProbe(
  fixture: Fixture,
  args: string[],
  overlay: Partial<SandboxRuntimeConfig> = workspaceSandboxOverlay(fixture.workspace),
  executable = fixture.node,
): Promise<string> {
  const scratch = sandboxTmpDirFor(overlay, fixture.scratch)
  const { argv } = await withSandboxWrapTmpDir(scratch, () =>
    SandboxManager.wrapWithSandboxArgv(formatArgvForShell(executable, args), '/bin/sh', overlay),
  )
  const [file, ...wrappedArgs] = argv
  assert.ok(file, 'ASRT must return an executable')
  const result = spawnSync(resolveSandboxShellExecutable(file), wrappedArgs, {
    cwd: fixture.workspace,
    encoding: 'utf8',
    timeout: 10_000,
    // No inherited auth or provider environment reaches the probe process.
    env: withSandboxTmpEnv({ PATH: process.env['PATH'] }, scratch),
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  return result.stdout
}

async function denied(
  fixture: Fixture,
  operation: 'read' | 'write' | 'unlink',
  target: string,
  overlay?: Partial<SandboxRuntimeConfig>,
): Promise<void> {
  assert.equal(
    await nodeProbe(fixture, ['-e', denialProbe, operation, target], overlay),
    'denied\n',
  )
}

describe(
  'automatic Node toolchain native Seatbelt contract',
  { skip: process.platform !== 'darwin' },
  () => {
    it(
      'executes real Node and reads its install without exposing home siblings or credentials',
      { timeout: 120_000 },
      async (t) => {
        await withFixture(t, async (fixture) => {
          assert.equal(
            await nodeProbe(fixture, ['-p', 'process.version'], undefined, 'node'),
            `${process.version}\n`,
          )
          const read = [
            '-e',
            "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
          ]
          assert.equal(
            await nodeProbe(fixture, [...read, fixture.toolchainData]),
            'toolchain data\n',
          )
          assert.equal(
            await nodeProbe(fixture, [...read, fixture.workspaceData]),
            'workspace data\n',
          )
          for (const target of [fixture.sibling, ...fixture.credentials])
            await denied(fixture, 'read', target)

          const alias = join(dirname(fixture.toolchainData), 'credential-alias')
          const credential = fixture.credentials[0]
          assert.ok(credential)
          symlinkSync(credential, alias)
          await denied(fixture, 'read', alias)
          for (const target of [fixture.toolchainData, fixture.sibling, ...fixture.credentials]) {
            await denied(fixture, 'write', target)
          }
          assert.equal(
            await nodeProbe(fixture, [
              '-e',
              "require('node:fs').writeFileSync(process.argv[1], 'allowed workspace write\\n')",
              fixture.workspaceData,
            ]),
            '',
          )
          assert.equal(readFileSync(fixture.workspaceData, 'utf8'), 'allowed workspace write\n')
          assert.equal(readFileSync(fixture.toolchainData, 'utf8'), 'toolchain data\n')
          for (const target of fixture.credentials)
            assert.equal(readFileSync(target, 'utf8'), 'synthetic credential\n')
        })
      },
    )

    it(
      'runs Node through an fnm multishell spelling without exposing or writing nearby data',
      { timeout: 120_000 },
      async (t) => {
        await withFixture(t, async (fixture) => {
          const install = join(
            fixture.home,
            '.local',
            'share',
            'fnm',
            'node-versions',
            process.version,
            'installation',
          )
          const node = join(install, 'bin', 'node')
          const data = join(install, 'lib', 'node_modules', 'fixture.txt')
          for (const file of [node, data]) mkdirSync(dirname(file), { recursive: true })
          copyFileSync(fixture.node, node)
          chmodSync(node, 0o755)
          writeFileSync(data, 'fnm toolchain data\n')
          const multishell = join(fixture.home, '.local', 'state', 'fnm_multishells', '1234')
          mkdirSync(dirname(multishell), { recursive: true })
          symlinkSync(install, multishell)
          const sibling = join(dirname(multishell), 'unrelated.txt')
          writeFileSync(sibling, 'unrelated fnm state\n')
          process.env['PATH'] = `${join(multishell, 'bin')}:/usr/bin:/bin`
          const fnm = { ...fixture, node, toolchainData: data }
          const overlay = workspaceSandboxOverlay(fixture.workspace)
          // No nvm/system Node fallback is on PATH. This must execute through
          // the lexical directory link that canonical-only grants broke.
          assert.equal(
            await nodeProbe(fnm, ['-p', 'process.version'], overlay, 'node'),
            `${process.version}\n`,
          )
          assert.equal(
            await nodeProbe(fnm, ['-p', 'process.execPath'], overlay, 'node'),
            `${node}\n`,
          )
          const lexicalData = join(multishell, 'lib', 'node_modules', 'fixture.txt')
          for (const file of [data, lexicalData]) {
            assert.equal(
              await nodeProbe(
                fnm,
                [
                  '-e',
                  "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
                  file,
                ],
                overlay,
                'node',
              ),
              'fnm toolchain data\n',
            )
            await denied(fnm, 'write', file, overlay)
          }
          for (const target of [sibling, fixture.sibling, ...fixture.credentials]) {
            await denied(fnm, 'read', target, overlay)
          }
          // The safety of the lexical exception depends on the contained
          // process being unable to retarget its parent link.
          await denied(fnm, 'unlink', multishell, overlay)
          assert.equal(realpathSync(multishell), install)
          assert.equal(readFileSync(data, 'utf8'), 'fnm toolchain data\n')
          assert.equal(readFileSync(sibling, 'utf8'), 'unrelated fnm state\n')
          for (const target of fixture.credentials)
            assert.equal(readFileSync(target, 'utf8'), 'synthetic credential\n')
        })
      },
    )

    it(
      'does not turn a writable PATH node alias into a credential read grant',
      { timeout: 120_000 },
      async (t) => {
        await withFixture(t, async (fixture) => {
          for (const [index, target] of fixture.credentials.entries()) {
            const pathDir = join(fixture.workspace, 'node_modules', `bin-${String(index)}`)
            mkdirSync(pathDir, { recursive: true })
            const alias = join(pathDir, 'node')
            symlinkSync(target, alias)
            process.env['PATH'] = `${pathDir}:${fixture.path}`
            const overlay = workspaceSandboxOverlay(fixture.workspace)
            await denied(fixture, 'read', target, overlay)
            await denied(fixture, 'read', alias, overlay)
            assert.equal(
              await nodeProbe(fixture, ['-p', 'process.version'], overlay),
              `${process.version}\n`,
            )
          }
        })
      },
    )

    it(
      'keeps automatic toolchain grants read-only when checkout writes are removed',
      { timeout: 120_000 },
      async (t) => {
        await withFixture(t, async (fixture) => {
          const overlay = withoutCheckoutWrites(
            workspaceSandboxOverlay(fixture.workspace),
            fixture.workspace,
          )
          const read = [
            '-e',
            "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
          ]
          assert.equal(
            await nodeProbe(fixture, [...read, fixture.workspaceData], overlay),
            'workspace data\n',
          )
          assert.equal(
            await nodeProbe(fixture, [...read, fixture.toolchainData], overlay),
            'toolchain data\n',
          )
          for (const target of [
            fixture.workspaceData,
            fixture.toolchainData,
            ...fixture.credentials,
          ]) {
            await denied(fixture, 'write', target, overlay)
          }
          const scratchFile = join(fixture.scratch, 'still-writable.txt')
          assert.equal(
            await nodeProbe(
              fixture,
              [
                '-e',
                "require('node:fs').writeFileSync(process.argv[1], 'scratch write\\n')",
                scratchFile,
              ],
              overlay,
            ),
            '',
          )
          assert.equal(readFileSync(scratchFile, 'utf8'), 'scratch write\n')
          assert.equal(readFileSync(fixture.workspaceData, 'utf8'), 'workspace data\n')
          assert.equal(readFileSync(fixture.toolchainData, 'utf8'), 'toolchain data\n')
          for (const target of fixture.credentials)
            assert.equal(readFileSync(target, 'utf8'), 'synthetic credential\n')
        })
      },
    )
  },
)
