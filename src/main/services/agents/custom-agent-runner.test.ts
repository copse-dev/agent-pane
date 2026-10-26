import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { AgentMetadata } from '@shared/types/agents.ts'
import { runCustomAgent } from './custom-agent-runner.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { readSkillTool } from '../../tools/read-skill-tool.ts'
import { getSkill, setSkillsForTest } from '../skills/skills-registry.ts'
import {
  createSkillActivationTurn,
  getSkillActivationTurn,
  MAX_MODEL_SKILL_CONTEXT_BYTES,
  runWithSkillActivationTurn,
} from '../skills/skill-activation.ts'
import { clearThreadReadRoots, threadReadRoots } from '../security/thread-read-roots.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

let root = ''
afterEach(async () => {
  setSkillsForTest([])
  clearThreadReadRoots()
  setWorkspaceRootForTest(null)
  if (root) await rm(root, { recursive: true, force: true })
})

describe('custom child skill execution', () => {
  it('progressively reads instructions and support in separate concurrent child budgets, without parent grants', async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-child-skills-'))
    setWorkspaceRootForTest(root)
    const skillRoot = join(root, 'tiny')
    await mkdir(skillRoot)
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: tiny\ndescription: Tiny workflow\ncopse-requirements:\n  executors: [subagent]\n---\nRead reference.md for the result.',
    )
    await writeFile(join(skillRoot, 'reference.md'), 'TINY-WORKFLOW-RESULT')
    setSkillsForTest([
      {
        name: 'tiny',
        description: 'Tiny workflow',
        source: 'project',
        skillRoot,
        skillPath: join(skillRoot, 'SKILL.md'),
        disableModelInvocation: false,
        requirements: { executors: ['subagent'] },
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
    const registry = new ToolRegistry()
    registry.register(readSkillTool)
    const parent = createSkillActivationTurn([], ['read_skill'], MAX_MODEL_SKILL_CONTEXT_BYTES)
    const turns = new Set<ReturnType<typeof getSkillActivationTurn>>()
    const agent: AgentMetadata = {
      name: 'tiny-reader',
      description: 'Read a skill',
      source: 'project',
      container: '.copse',
      agentPath: join(root, 'tiny-reader.md'),
      unsupportedFields: [],
      body: 'Read the tiny skill.',
      tools: ['read_skill'],
      disallowedTools: [],
      model: 'inherit',
      readonly: true,
      maxTurns: 6,
      color: null,
    }
    async function child(id: string): Promise<string> {
      let step = 0
      const provider: LLMProvider = {
        async *stream(messages, tools): AsyncGenerator<ProviderStreamChunk> {
          const turn = getSkillActivationTurn()
          assert.ok(turn)
          assert.notEqual(turn, parent)
          turns.add(turn)
          const systemPrompt = messages.find((message) => message.role === 'system')?.content ?? ''
          assert.doesNotMatch(systemPrompt, /<agent_skill name="native-only"/)
          await assert.rejects(
            turn.read('native-only', undefined, new AbortController().signal),
            /blocked|not eligible/,
          )
          assert.deepEqual(
            tools.map((tool) => tool.name),
            ['read_skill'],
          )
          assert.match(JSON.stringify(messages), /available_skills/)
          if (step === 1) assert.match(JSON.stringify(messages), /Read reference.md for the result/)
          if (step === 2) {
            assert.match(JSON.stringify(messages), /TINY-WORKFLOW-RESULT/)
            yield { type: 'text', text: 'Tiny workflow completed.' }
          } else {
            yield {
              type: 'tool_call',
              toolCall: {
                id: `${id}-${String(step)}`,
                name: 'read_skill',
                args: { name: 'tiny', ...(step === 1 ? { path: 'reference.md' } : {}) },
              },
            }
          }
          step++
          yield { type: 'done' }
        },
      }
      return runCustomAgent(
        {
          parentToolCallId: id,
          parentGoal: 'Complete tiny workflow',
          provider,
          parentModel: 'test-model',
          registry,
          contextWindow: 64_000,
          toolSchemaReserve: 1_000,
          onChunk: () => {},
        },
        agent,
        'Read tiny and its reference.',
        new AbortController().signal,
      )
    }
    await runWithSkillActivationTurn(parent, async () => {
      assert.deepEqual(await Promise.all([child('one'), child('two')]), [
        'Tiny workflow completed.',
        'Tiny workflow completed.',
      ])
      assert.equal(getSkillActivationTurn(), parent)
      await assert.rejects(
        parent.read('tiny', undefined, new AbortController().signal),
        /context limit/,
      )
    })
    assert.equal(turns.size, 2)
    assert.deepEqual(threadReadRoots('one'), [])
    assert.deepEqual(threadReadRoots('two'), [])
  })
})
