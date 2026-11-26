import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProjectSandbox, isProjectSandboxEnabled, shutdownProjectSandbox } from './index.ts'
import { runWithActiveRunIdentity } from '../services/active-run-identity.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setApprovalHandler } from '../services/approval.ts'
import { ensureToolPermitted } from '../services/security/permission-gate.ts'
import { shellRunsOutsideSandbox } from '../services/security/command-routing-config.ts'
import { getSetting, setSetting } from '../services/storage/settings.ts'
import { AUTO_APPROVAL_LEVEL_SETTING, type AutoApprovalLevel } from '@shared/auto-approval.ts'
import { runShellTool } from '../tools/shell-tool.ts'

/** The first of this host's command-line tools that resolves, or null. */
function onPath(name: string): string | null {
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/** A pnpm version already in Corepack's default cache, so the run needs no download. */
function cachedPnpm(): string | null {
  const dir = join(homedir(), '.cache', 'node', 'corepack', 'v1', 'pnpm')
  return existsSync(dir)
    ? (readdirSync(dir).find((name) => /^\d+\.\d+\.\d+$/.test(name)) ?? null)
    : null
}

/** An installed fnm Node version under fnm's default data directory. */
function fnmNode(): string | null {
  for (const root of [
    join(homedir(), '.local', 'share', 'fnm'),
    join(homedir(), 'Library', 'Application Support', 'fnm'),
  ]) {
    const versions = join(root, 'node-versions')
    if (existsSync(versions)) {
      const found = readdirSync(versions).find((name) => /^v\d+\.\d+\.\d+$/.test(name))
      if (found) return found
    }
  }
  return null
}

it('starts Corepack and fnm exec commands contained through the real shell gate and sandbox', async (t) => {
  if (process.platform === 'win32') {
    t.skip('no project OS sandbox on Windows')
    return
  }
  const pnpm = onPath('corepack') ? cachedPnpm() : null
  const node = onPath('fnm') ? fnmNode() : null
  if (!pnpm && !node) {
    t.skip('needs Corepack with a cached pnpm or fnm with an installed Node on this host')
    return
  }
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'copse-toolchain-launchers-')))
  const root = join(fixture, 'project')
  const outside = join(fixture, 'outside.txt')
  mkdirSync(root)
  const previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = join(fixture, 'store')
  const restoreRoot = setWorkspaceRootForTest(root)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, packageManager: `pnpm@${pnpm ?? '10.0.0'}` }),
  )
  writeFileSync(
    join(root, 'escape.mjs'),
    [
      "import fs from 'node:fs'",
      'try {',
      `  fs.writeFileSync(${JSON.stringify(outside)}, 'escape')`,
      "  console.log('escaped')",
      '} catch (error) {',
      '  console.log(`contained ${error.code}`)',
      '}',
    ].join('\n'),
  )
  const previous = {
    autoRun: getSetting('autoRunSandboxCommands', true),
    classifier: getSetting('safetyClassifierEnabled', true),
    overrides: getSetting('toolPermissionOverrides', {}),
    autoApproval: getSetting<AutoApprovalLevel>(AUTO_APPROVAL_LEVEL_SETTING, 'off'),
  }
  let prompts = 0
  setApprovalHandler(async () => {
    prompts++
    return { approved: false, remember: false }
  })
  const context = {
    projectId: 'toolchain-project',
    threadId: 'toolchain-thread',
    projectRoot: root,
    root,
    checkoutMode: 'shared' as const,
    branch: null,
  }
  try {
    await setSetting('autoRunSandboxCommands', true)
    await setSetting('safetyClassifierEnabled', false)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    await setSetting('toolPermissionOverrides', {})
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT unavailable on this host; real containment evidence needs a sandbox-capable run')
      return
    }
    const run = (command: string): Promise<string> =>
      runWithThreadExecutionContext(context, () =>
        runWithActiveRunIdentity(context.threadId, async () => {
          assert.equal(
            await ensureToolPermitted({ toolName: 'run_shell', args: { command } }),
            true,
            command,
          )
          assert.equal(
            shellRunsOutsideSandbox(command, { projectRoot: root, executionRoot: root }),
            false,
            command,
          )
          const output = await runShellTool.execute(
            { command, timeout_ms: 30_000 },
            new AbortController().signal,
          )
          return typeof output === 'string' ? output : JSON.stringify(output)
        }),
      )
    if (pnpm) {
      const output = await run('corepack pnpm --version')
      assert.ok(output.includes(pnpm), output)
      t.diagnostic(`corepack pnpm --version ran contained: pnpm ${pnpm}`)
    }
    if (node) {
      const output = await run(`fnm exec --using=${node} node --version`)
      assert.ok(output.includes(node), output)
      const escape = await run(`fnm exec --using=${node} node escape.mjs`)
      assert.ok(/contained E(?:PERM|ACCES)/.test(escape), escape)
      t.diagnostic(`fnm exec --using=${node} ran contained; a write outside the project failed`)
    }
    assert.equal(existsSync(outside), false)
    assert.equal(prompts, 0, 'contained toolchain launchers must not ask or escalate')
  } finally {
    await shutdownProjectSandbox()
    setApprovalHandler(null)
    await setSetting('autoRunSandboxCommands', previous.autoRun)
    await setSetting('safetyClassifierEnabled', previous.classifier)
    await setSetting('toolPermissionOverrides', previous.overrides)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, previous.autoApproval)
    restoreRoot()
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    rmSync(fixture, { recursive: true, force: true })
  }
})
