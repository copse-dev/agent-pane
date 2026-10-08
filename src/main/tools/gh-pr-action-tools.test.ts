import { normalizeToolExecuteResult, type ToolExecuteResult } from '@shared/types'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ghPushTool } from './gh-pr-action-tools.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'

it('pushes only the owning thread branch and refuses a switched or detached checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copse-push-tool-'))
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  try {
    await mkdir(repo)
    git('init', '--bare', '-q', remote)
    git('init', '-q', '-b', 'feature')
    git('config', 'user.name', 'Copse Test')
    git('config', 'user.email', 'test@copse.dev')
    await writeFile(join(repo, 'plan.md'), 'Plan\n')
    git('add', '.')
    git('commit', '-qm', 'Plan')
    git('remote', 'add', 'origin', remote)
    const context = {
      projectId: 'project',
      threadId: 'thread',
      projectRoot: root,
      root: repo,
      checkoutMode: 'shared' as const,
      branch: 'feature',
    }
    const push = (): ToolExecuteResult | Promise<ToolExecuteResult> =>
      runWithThreadExecutionContext(context, () =>
        ghPushTool.execute({}, new AbortController().signal),
      )
    assert.match(normalizeToolExecuteResult(await push()).result, /^Done:/)
    assert.equal(
      git('--git-dir', remote, 'rev-parse', 'refs/heads/feature'),
      git('rev-parse', 'HEAD'),
    )
    git('switch', '-qc', 'other')
    assert.match(normalizeToolExecuteResult(await push()).result, /^Failed:/)
    assert.throws(() => git('--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/other'))
    git('checkout', '--detach')
    assert.match(normalizeToolExecuteResult(await push()).result, /^Failed:/)
    assert.match(
      normalizeToolExecuteResult(await ghPushTool.execute({}, new AbortController().signal)).result,
      /^Failed:/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
