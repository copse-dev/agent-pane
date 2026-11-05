import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAcpAgentFromSettings } from './acp-agent-service.ts'
import { disposeAllAcpSessions } from './acp-session-pool.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { readSkillTool } from '../../tools/read-skill-tool.ts'
import { getSkill, setSkillsForTest } from '../skills/skills-registry.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import {
  createSkillActivationTurn,
  MAX_MODEL_SKILL_CONTEXT_BYTES,
  runWithSkillActivationTurn,
} from '../skills/skill-activation.ts'

let root = ''
afterEach(async () => {
  await disposeAllAcpSessions()
  setSkillsForTest([])
  setWorkspaceRootForTest(null)
  await setSetting('registeredAcpAgents', [])
  if (root) {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}-retry-marker`, { force: true })
  }
})

describe('Copse skills in a spawned ACP executor', () => {
  it('negotiates the actual catalog and tool bridge, reads a workflow and support, and resets for the next prompt', async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-acp-skill-spawn-'))
    execFileSync('git', ['init', '--quiet', root])
    setWorkspaceRootForTest(root)
    const skillRoot = join(root, '.cursor', 'skills', 'tiny')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: tiny\ndescription: Tiny workflow\ncopse-requirements:\n  executors: [acp]\n---\nRead reference.md.',
    )
    await writeFile(join(skillRoot, 'reference.md'), 'SPAWNED-ACP-WORKFLOW-RESULT')
    setSkillsForTest([
      {
        name: 'tiny',
        description: 'Tiny workflow',
        source: 'project',
        skillRoot,
        skillPath: join(skillRoot, 'SKILL.md'),
        disableModelInvocation: false,
        requirements: { executors: ['acp'] },
        paths: [],
        externalLinks: [],
        missingReferences: [],
      },
    ])
    const nativeRoot = join(root, 'native-only')
    await mkdir(nativeRoot)
    await writeFile(
      join(nativeRoot, 'SKILL.md'),
      '---\nname: native-only\ndescription: Native only\ncopse-requirements:\n  executors: [native]\n---\nNATIVE_ONLY_BODY',
    )
    const tiny = getSkill('tiny')
    assert.ok(tiny)
    setSkillsForTest([
      tiny,
      {
        ...tiny,
        name: 'native-only',
        skillRoot: nativeRoot,
        skillPath: join(nativeRoot, 'SKILL.md'),
        requirements: { executors: ['native'] },
      },
    ])
    await setSetting('registeredAcpAgents', [
      {
        id: 'skill-probe',
        title: 'Skill boundary probe',
        command: process.execPath,
        args: [resolve('tests/fixtures/mock-acp-skill-agent.mjs')],
        enabled: true,
      },
    ])
    const registry = new ToolRegistry()
    registry.register(readSkillTool)
    const parent = createSkillActivationTurn([], ['read_skill'], MAX_MODEL_SKILL_CONTEXT_BYTES)
    await runWithSkillActivationTurn(parent, () =>
      runWithThreadExecutionContext(
        {
          projectId: 'skill-spawn',
          threadId: 'skill-spawn-thread',
          projectRoot: root,
          root,
          checkoutMode: 'shared',
          branch: 'main',
        },
        async () => {
          for (const invokedSkills of [[], ['tiny']]) {
            const result = await runAcpAgentFromSettings({
              threadId: 'skill-spawn-thread',
              agentId: 'skill-probe',
              userPrompt: 'Complete the tiny workflow.',
              priorMessages: [],
              invokedSkills,
              signal: AbortSignal.timeout(20_000),
              onChunk: () => {},
              registry,
            })
            assert.equal(result.stopReason, 'end_turn')
            assert.match(JSON.stringify(result.messages), /SPAWNED-ACP-WORKFLOW-RESULT/)
            assert.match(JSON.stringify(result.messages), /UNTRUSTED SOURCE/)
          }
          const blocked = await runAcpAgentFromSettings({
            threadId: 'skill-spawn-thread',
            agentId: 'skill-probe',
            userPrompt: 'Inspect native-only preflight.',
            priorMessages: [],
            invokedSkills: ['native-only'],
            signal: AbortSignal.timeout(20_000),
            onChunk: () => {},
            registry,
          })
          assert.match(JSON.stringify(blocked.messages), /BLOCKED BEFORE INSTRUCTIONS/)
          await setSetting('registeredAcpAgents', [
            {
              id: 'skill-probe',
              title: 'Skill boundary probe',
              command: process.execPath,
              args: [
                resolve('tests/fixtures/mock-acp-skill-agent.mjs'),
                '--retry-once',
                `${root}-retry-marker`,
              ],
              enabled: true,
            },
          ])
          const retried = await runAcpAgentFromSettings({
            threadId: 'skill-spawn-thread',
            agentId: 'skill-probe',
            userPrompt: 'Complete the tiny workflow.',
            priorMessages: [],
            signal: AbortSignal.timeout(20_000),
            onChunk: () => {},
            registry,
          })
          assert.equal(await readFile(`${root}-retry-marker`, 'utf-8'), 'retry')
          assert.match(JSON.stringify(retried.messages), /RESTORED RUN CONTEXT/)
        },
      ),
    )
    await assert.rejects(
      parent.read('tiny', undefined, new AbortController().signal),
      /context limit/,
    )
  })
})
