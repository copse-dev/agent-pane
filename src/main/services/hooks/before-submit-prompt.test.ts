// Contract tests for the `beforeSubmitPrompt` compose-path fire site (B1).
//
// Pins the B1 acceptance surface: `continue: false` blocks the submit;
// `continue: true` / an absent `continue` allow it; and a halting hook's
// `user_message` is carried on the decision so the compose path can surface it
// (decision 12 `haltRun`, decisions-log). Same house style as
// `cursor-adapter.test.ts` — a real spawned script driven through the canonical
// `beforeSubmitPrompt` registry → runner → adapter seam.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import { runBeforeSubmitPromptHooks } from './before-submit-prompt.ts'

/** Fire the canonical beforeSubmitPrompt event (the production compose path). */
function submit(prompt: string): ReturnType<typeof runBeforeSubmitPromptHooks> {
  return runBeforeSubmitPromptHooks(prompt, { workspaceRoot: null, projectTrusted: false })
}

describe('before-submit-prompt (beforeSubmitPrompt compose path — B1)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-before-submit-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    setCursorHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCursorHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  /** Write an executable shell script that prints `responseJson` on stdout. */
  async function writeHookScript(name: string, responseJson: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${responseJson}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  it('allows the submit when no beforeSubmitPrompt hooks are registered', async () => {
    const decision = await submit('hello')
    assert.equal(decision.blocked, false)
    assert.equal(decision.userMessage, undefined)
  })

  it('continue:false blocks the submit and carries user_message (decision 12)', async () => {
    const script = await writeHookScript(
      'block.sh',
      '{"continue":false,"user_message":"blocked: secrets in prompt"}',
    )
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: script }] } })

    const decision = await submit('leak my API key')
    assert.equal(decision.blocked, true)
    assert.equal(decision.userMessage, 'blocked: secrets in prompt')
    assert.equal(decision.reason, 'blocked: secrets in prompt')
  })

  it('accepts the camelCase userMessage spelling too', async () => {
    const script = await writeHookScript(
      'block-camel.sh',
      '{"continue":false,"userMessage":"nope"}',
    )
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: script }] } })

    const decision = await submit('anything')
    assert.equal(decision.blocked, true)
    assert.equal(decision.userMessage, 'nope')
  })

  it('carries agentMessage on a halt when present', async () => {
    const script = await writeHookScript(
      'block-agent.sh',
      '{"continue":false,"user_message":"stop","agent_message":"tell the model why"}',
    )
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: script }] } })

    const decision = await submit('go')
    assert.equal(decision.blocked, true)
    assert.equal(decision.agentMessage, 'tell the model why')
  })

  it('continue:true allows the submit', async () => {
    const script = await writeHookScript('allow.sh', '{"continue":true}')
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: script }] } })

    const decision = await submit('proceed')
    assert.equal(decision.blocked, false)
  })

  it('an absent continue field allows the submit', async () => {
    const script = await writeHookScript('empty.sh', '{}')
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: script }] } })

    const decision = await submit('proceed')
    assert.equal(decision.blocked, false)
  })

  it('empty stdout on a clean exit allows the submit', async () => {
    const path = join(tempHome, 'silent.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 0\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: path }] } })

    const decision = await submit('proceed')
    assert.equal(decision.blocked, false)
  })

  it('fails open when a hook crashes (default) — the submit proceeds', async () => {
    const path = join(tempHome, 'crash.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: path }] } })

    const decision = await submit('proceed')
    assert.equal(decision.blocked, false)
  })

  it('failClosed blocks the submit when a hook crashes', async () => {
    const path = join(tempHome, 'crash-closed.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({
      hooks: { beforeSubmitPrompt: [{ command: path, failClosed: true }] },
    })

    const decision = await submit('proceed')
    assert.equal(decision.blocked, true)
  })

  // H2 (docs/plans/hooks-and-feature-packs.md): a compose-path hook may inject
  // current-turn context via `additionalContext`, folded into the turn's
  // system-reminder block (the local compose path applies it to messages[0]).
  it('maps additionalContext into a current-turn system-reminder block (H2)', async () => {
    const script = await writeHookScript(
      'inject.sh',
      '{"continue":true,"additionalContext":"follow the checklist"}',
    )
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: script }] } })

    const decision = await submit('proceed')
    assert.equal(decision.blocked, false)
    assert.equal(
      decision.injectContext,
      '<system-reminder>\nfollow the checklist\n</system-reminder>',
    )
  })

  it('drops injected context when the submit is halted (H2)', async () => {
    const script = await writeHookScript(
      'inject-halt.sh',
      '{"continue":false,"user_message":"no","additionalContext":"never applied"}',
    )
    await writeUserHooks({ hooks: { beforeSubmitPrompt: [{ command: script }] } })

    const decision = await submit('go')
    assert.equal(decision.blocked, true)
    assert.equal(decision.injectContext, undefined)
  })

  it('a project hook is ignored unless the workspace is trusted', async () => {
    const script = await writeHookScript('proj-block.sh', '{"continue":false}')
    const projectRoot = await mkdtemp(join(tmpdir(), 'copse-before-submit-proj-'))
    try {
      await mkdir(join(projectRoot, '.cursor'), { recursive: true })
      await writeFile(
        join(projectRoot, '.cursor', 'hooks.json'),
        JSON.stringify({ hooks: { beforeSubmitPrompt: [{ command: script }] } }),
        'utf-8',
      )

      const untrusted = await runBeforeSubmitPromptHooks('go', {
        workspaceRoot: projectRoot,
        projectTrusted: false,
      })
      assert.equal(untrusted.blocked, false)

      const trusted = await runBeforeSubmitPromptHooks('go', {
        workspaceRoot: projectRoot,
        projectTrusted: true,
      })
      assert.equal(trusted.blocked, true)
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
