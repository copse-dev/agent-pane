import {
  createSkillActivationTurn,
  MAX_MODEL_SKILL_CONTEXT_BYTES,
} from '../skills/skill-activation.ts'
import { buildSkillsCatalogBlock } from '../skills/skill-prompt.ts'

/** Use only tools actually negotiated with this executor, never the registry's superset. */
interface AcpSkillContextOptions {
  toolNames: readonly string[]
  invokedSkills: readonly string[]
  skillsBlock: string
  includeCatalog: boolean
}

interface AcpSkillContext {
  activation: ReturnType<typeof createSkillActivationTurn>
  prompt: string
}

/** Retries and automatic checkout continuations belong to one bounded run. */
export function createAcpSkillRun(): (options: AcpSkillContextOptions) => AcpSkillContext {
  let activation: ReturnType<typeof createSkillActivationTurn> | undefined
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
    activation ??= createSkillActivationTurn(options.invokedSkills, options.toolNames, bytes)
    return {
      activation,
      prompt:
        (options.includeCatalog ? buildSkillsCatalogBlock(options.toolNames) : '') +
        options.skillsBlock,
    }
  }
}
