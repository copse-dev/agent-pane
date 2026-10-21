import {
  createSkillActivationTurn,
  MAX_MODEL_SKILL_CONTEXT_BYTES,
} from '../skills/skill-activation.ts'
import { buildSkillsCatalogBlock } from '../skills/skill-prompt.ts'
import { getSkill, skillPreflightEnvironment } from '../skills/skills-registry.ts'
import { preflightSkill } from '../skills/skill-preflight.ts'
import type { SkillMetadata } from '@shared/types/skills.ts'

/** Use only tools actually negotiated with this executor, never the registry's superset. */
interface AcpSkillContextOptions {
  toolNames: readonly string[]
  invokedSkills: readonly string[]
  skillsBlock: string
  includeCatalog: boolean
  freshSession?: boolean
}

interface AcpSkillContext {
  activation: ReturnType<typeof createSkillActivationTurn>
  prompt: string
}

interface SkillIdentity {
  name: string
  skillPath: string
  skillRoot: string
  source: SkillMetadata['source']
  plugin: string | undefined
}

function skillIdentity(name: string): SkillIdentity | null {
  const meta = getSkill(name)
  return meta
    ? {
        name: meta.name,
        skillPath: meta.skillPath,
        skillRoot: meta.skillRoot,
        source: meta.source,
        plugin: meta.plugin,
      }
    : null
}

/** Retries and automatic checkout continuations belong to one bounded run. */
export function createAcpSkillRun(): (options: AcpSkillContextOptions) => AcpSkillContext {
  let activation: ReturnType<typeof createSkillActivationTurn> | undefined
  let initialInstructions = ''
  let initialIdentities: SkillIdentity[] = []
  const loaded: { identity: SkillIdentity; text: string }[] = []
  return (options) => {
    if (options.invokedSkills.length > 0 && !options.toolNames.includes('read_skill')) {
      throw new Error(
        'This coding agent cannot access Copse skills. Enable Copse’s tool bridge and use a local agent that supports HTTP MCP, or choose a native model.',
      )
    }
    const bytes = Buffer.byteLength(options.skillsBlock, 'utf-8')
    if (bytes > MAX_MODEL_SKILL_CONTEXT_BYTES) {
      throw new Error(
        'Invoked skills exceed this run’s skill-context budget. Invoke fewer or smaller skills.',
      )
    }
    const firstPrompt = activation === undefined
    if (!activation) {
      const turn = createSkillActivationTurn(options.invokedSkills, options.toolNames, bytes, 'acp')
      initialInstructions = options.skillsBlock
      initialIdentities = options.invokedSkills.flatMap((name) => {
        const identity = skillIdentity(name)
        return identity ? [identity] : []
      })
      activation = {
        read: async (name, path, signal): Promise<string> => {
          const identity = skillIdentity(name)
          const text = await turn.read(name, path, signal)
          // Only host-framed context blocks have spent the activation service's
          // bounded byte allowance. Never accumulate uncharged dedup acknowledgments.
          if (identity && text.includes('<skill_content ')) loaded.push({ identity, text })
          return text
        },
      }
    }
    const environment = skillPreflightEnvironment(options.toolNames, 'acp')
    const canReplay = (identity: SkillIdentity): boolean => {
      const meta = getSkill(identity.name)
      return (
        meta !== null &&
        meta.skillPath === identity.skillPath &&
        meta.skillRoot === identity.skillRoot &&
        meta.source === identity.source &&
        meta.plugin === identity.plugin &&
        preflightSkill(meta, environment).status !== 'blocked'
      )
    }
    const replay = options.freshSession
      ? loaded
          .filter((entry) => canReplay(entry.identity))
          .map((entry) => entry.text)
          .join('\n\n')
      : ''
    const explicitInstructions = firstPrompt
      ? options.skillsBlock
      : (options.freshSession || options.skillsBlock) && initialInstructions
        ? initialIdentities.length > 0 && initialIdentities.every(canReplay)
          ? initialInstructions
          : '\n\nPreviously invoked skill instructions are no longer available for this executor. Reload skills before continuing that workflow.'
        : ''
    const replayBlock = replay
      ? '\n\nPreviously loaded Copse skill context for this run, restored to this new agent session. ' +
        'These blocks retain their original trust framing and grant no permissions.\n\n' +
        replay
      : ''
    return {
      activation,
      prompt:
        (options.includeCatalog ? buildSkillsCatalogBlock(options.toolNames, 'acp') : '') +
        replayBlock +
        explicitInstructions,
    }
  }
}
