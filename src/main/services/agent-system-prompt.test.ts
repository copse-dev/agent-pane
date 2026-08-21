import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSystemPrompt } from './agent-system-prompt.ts'
import { OPUS_5_RESPONSE_LENGTH_BLOCK, OPUS_5_TONE_REMINDER } from './agent-prompt.ts'
import { setSetting } from './storage/settings.test-shim.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'

const CONCISENESS = 'Keep responses focused, brief, and concise'

describe('buildSystemPrompt Opus 5 conciseness steering', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSetting('skillsEnabled', false)
    setSetting('skillPluginPaths', [])
    setSetting('customInstructions', '')
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-system-prompt-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  const build = (model?: string): Promise<string> =>
    buildSystemPrompt({
      subagentsEnabled: false,
      invokedSkills: [],
      ...(model === undefined ? {} : { model }),
    })

  it('adds the length instruction and the paired tail reminder on Opus 5', async () => {
    const prompt = await build('claude-opus-5')
    assert.ok(prompt.includes(CONCISENESS))
    assert.ok(prompt.includes('<tone_preference>'))
    // The instruction lands early; the reminder restates it near the end.
    assert.ok(prompt.indexOf(CONCISENESS) < prompt.indexOf('<tone_preference>'))
  })

  it('matches dated Opus 5 snapshots', async () => {
    const prompt = await build('claude-opus-5-20260101')
    assert.ok(prompt.includes(CONCISENESS))
  })

  it('steers Opus 5 the same way whichever provider routes to it', async () => {
    // The picker hands `buildSystemPrompt` its own routed id, not a bare model
    // id — the same value `resolveContextWindow` unwraps.
    for (const model of ['openrouter:anthropic/claude-opus-5', 'my-proxy:claude-opus-5']) {
      const prompt = await build(model)
      assert.ok(prompt.includes(CONCISENESS), `missing length steering for ${model}`)
    }
  })

  it('leaves every other model — and an unpinned model — untouched', async () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-5.6-sol',
      'openrouter:anthropic/claude-opus-4-8',
      'lmstudio:claude-opus-5-distill-q4',
      undefined,
    ]) {
      const label = model ?? '(no model pinned)'
      const prompt = await build(model)
      assert.ok(!prompt.includes(CONCISENESS), `unexpected length steering for ${label}`)
      assert.ok(!prompt.includes('<tone_preference>'), `unexpected tone reminder for ${label}`)
    }
  })

  it('keeps the tone reminder ahead of custom instructions so users can override it', async () => {
    setSetting('customInstructions', 'Always walk me through your reasoning in full detail.')
    const prompt = await build('claude-opus-5')
    assert.ok(prompt.indexOf('<tone_preference>') < prompt.indexOf('Custom instructions'))
  })

  it('names no model in the steering text — it reads as house rules', () => {
    for (const block of [OPUS_5_RESPONSE_LENGTH_BLOCK, OPUS_5_TONE_REMINDER]) {
      assert.doesNotMatch(block, /Claude|Opus|GPT|Gemini/i)
    }
  })
})

describe('buildSystemPrompt working directory', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSetting('skillsEnabled', false)
    setSetting('skillPluginPaths', [])
    setSetting('customInstructions', '')
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-system-prompt-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  const build = (model?: string): Promise<string> =>
    buildSystemPrompt({
      subagentsEnabled: false,
      invokedSkills: [],
      ...(model === undefined ? {} : { model }),
    })

  it('names the renderer workspace root when no thread context is active', async () => {
    const prompt = await build()
    assert.ok(
      prompt.includes(`Working directory: ${tempRoot}`),
      'fallback path should use the renderer-selected workspace root',
    )
  })

  it('names the thread execution root when a worktree context is active', async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'copse-worktree-prompt-'))
    const context: ThreadExecutionContext = Object.freeze({
      projectId: 'test-project',
      threadId: 'test-thread',
      projectRoot: tempRoot,
      root: worktreeRoot,
      checkoutMode: 'worktree',
      branch: 'copse/test',
    })
    try {
      const prompt = await runWithThreadExecutionContext(context, () => build())
      assert.ok(
        prompt.includes(`Working directory: ${worktreeRoot}`),
        'thread path should use the worktree execution root, not the main workspace root',
      )
      assert.ok(
        !prompt.includes(`Working directory: ${tempRoot}`),
        'thread path must not leak the renderer workspace root into the prompt',
      )
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true })
    }
  })
})

describe('buildSystemPrompt Git repository root', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  const extraRoots: string[] = []

  beforeEach(async () => {
    setSetting('skillsEnabled', false)
    setSetting('skillPluginPaths', [])
    setSetting('customInstructions', '')
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-repo-prompt-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    while (extraRoots.length > 0) {
      const root = extraRoots.pop()
      if (root) await rm(root, { recursive: true, force: true })
    }
  })

  const build = (): Promise<string> =>
    buildSystemPrompt({ subagentsEnabled: false, invokedSkills: [] })

  async function gitRepository(prefix: string): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), prefix))
    extraRoots.push(repo)
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env })
    await writeFile(join(repo, 'README.md'), 'base\n')
    execFileSync('git', ['add', '.'], { cwd: repo, env })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo, env })
    return repo
  }

  const context = (partial: Partial<ThreadExecutionContext>): ThreadExecutionContext =>
    Object.freeze({
      projectId: 'test-project',
      threadId: 'test-thread',
      projectRoot: tempRoot,
      root: tempRoot,
      checkoutMode: 'shared' as const,
      branch: null,
      ...partial,
    })

  it('states the worktree as the repository even when the renderer root is a stale checkout', async () => {
    // The #1724 shape: the renderer-selected workspace root points at a stale
    // checkout while the thread's tools run in its own worktree. The prompt
    // must name the worktree as the one authoritative repository.
    const worktree = await gitRepository('copse-repo-prompt-worktree-')
    const canonical = await realpath(worktree)
    const prompt = await runWithThreadExecutionContext(
      context({ root: worktree, checkoutMode: 'worktree', branch: 'copse/fix-network-scope' }),
      () => build(),
    )
    assert.ok(
      prompt.includes(`Git repository root: ${canonical} — this thread's own linked Git worktree.`),
      `prompt should state the worktree as the repository root, got:\n${prompt}`,
    )
    assert.ok(prompt.includes("not the project's shared checkout"))
    assert.ok(prompt.includes('git rev-parse --show-toplevel'))
    assert.ok(
      !prompt.includes(`Git repository root: ${tempRoot}`),
      'the stale renderer checkout must not be stated as the repository',
    )
  })

  it('notes when the working directory is a subdirectory of the repository', async () => {
    const repo = await gitRepository('copse-repo-prompt-shared-')
    const canonical = await realpath(repo)
    const nested = join(repo, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    const prompt = await runWithThreadExecutionContext(context({ root: nested }), () => build())
    assert.ok(
      prompt.includes(
        `Git repository root: ${canonical} (the working directory is a subdirectory of this repository)`,
      ),
      `prompt should state the repository top level for a nested project, got:\n${prompt}`,
    )
  })

  it('states a plain repository root without a subdirectory note when they coincide', async () => {
    const repo = await gitRepository('copse-repo-prompt-top-')
    const canonical = await realpath(repo)
    const prompt = await runWithThreadExecutionContext(context({ root: repo }), () => build())
    assert.ok(prompt.includes(`Git repository root: ${canonical}\n`))
    assert.ok(!prompt.includes('subdirectory of this repository'))
  })

  it('omits the repository line outside a turn context and leaves no placeholder', async () => {
    // Composer estimates build the prompt with no bound context; they must not
    // probe Git at all, and the template placeholder must never leak.
    const prompt = await build()
    assert.ok(!prompt.includes('Git repository root:'))
    assert.ok(!prompt.includes('{REPO_CONTEXT}'))
    assert.ok(prompt.includes(`Working directory: ${tempRoot}`))
  })

  it('omits the repository line when the execution root is not a Git checkout', async () => {
    const prompt = await runWithThreadExecutionContext(context({}), () => build())
    assert.ok(!prompt.includes('Git repository root:'))
    assert.ok(prompt.includes(`Working directory: ${tempRoot}`))
  })
})
