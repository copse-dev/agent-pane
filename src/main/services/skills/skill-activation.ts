import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getSkill, readSkill } from './skills-registry.ts'
import { buildModelActivatedSkillBlock, modelInvocableSkillsForTools } from './skill-prompt.ts'
import { decodeSkillDefinition } from './parse-skill-frontmatter.ts'

export const MAX_MODEL_ACTIVATED_SKILLS = 4
export const MAX_MODEL_SKILL_CONTEXT_BYTES = 128 * 1024

export interface SkillActivationTurn {
  read(name: string, path: string | undefined, signal: AbortSignal): Promise<string>
}

/** State belongs to one native parent run, including its bounded parent continuations. */
export function createSkillActivationTurn(
  invokedSkills: readonly string[],
  availableToolNames: readonly string[],
  invokedSkillContextBytes = 0,
): SkillActivationTurn {
  const eligible = new Map(
    modelInvocableSkillsForTools(availableToolNames).map((skill) => [skill.name, skill.skillPath]),
  )
  const manual = new Set(
    invokedSkills.flatMap((name) => {
      const skill = getSkill(name)
      return skill && skill.userInvocable !== false ? [skill.skillPath] : []
    }),
  )
  const active = new Map<string, Promise<void>>()
  // Explicit invocations remain intact, but already-injected prompt text spends
  // the same budget as subsequent automatic activations and supporting reads.
  let contextBytes = invokedSkillContextBytes

  function chargeContext(block: string): number {
    const bytes = Buffer.byteLength(block, 'utf-8')
    if (contextBytes + bytes > MAX_MODEL_SKILL_CONTEXT_BYTES) {
      throw new Error(
        `Model skill context limit reached (${String(MAX_MODEL_SKILL_CONTEXT_BYTES)} bytes per turn). Continue with the skills already loaded.`,
      )
    }
    // Charge synchronously after I/O: concurrent reads cannot spend the same remaining bytes.
    contextBytes += bytes
    return bytes
  }

  return {
    async read(name: string, path: string | undefined, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted()
      const meta = getSkill(name)
      // Preserve the registry's actionable unknown/plugin/off-switch diagnostics.
      if (!meta) return (await readSkill(name, path)).body
      const manuallyInvoked = manual.has(meta.skillPath)
      if (
        !manuallyInvoked &&
        (meta.disableModelInvocation || eligible.get(meta.name) !== meta.skillPath)
      ) {
        throw new Error(`Skill "${meta.name}" is not eligible for model activation in this turn.`)
      }
      const instructions =
        resolve(meta.skillRoot, (path ?? 'SKILL.md').replace(/^\/+/, '')) === meta.skillPath
      if (!instructions && !manuallyInvoked && !active.has(meta.skillPath)) {
        throw new Error(
          `Activate "${meta.name}" by reading SKILL.md before loading its supporting files.`,
        )
      }
      if (instructions && manuallyInvoked) {
        return `Skill "${meta.name}" was explicitly invoked by the user. Its instructions are already in this turn; do not load them again.`
      }
      const prior = active.get(meta.skillPath)
      if (instructions && prior) {
        await prior
        if (!active.has(meta.skillPath))
          throw new Error(
            `Skill "${meta.name}" failed to activate. Retry only after resolving the earlier error.`,
          )
        return `Skill "${meta.name}" is already active in this turn. Use its loaded instructions; do not activate it again.`
      }
      if (!instructions) {
        if (prior) await prior
        if (!manuallyInvoked && !active.has(meta.skillPath))
          throw new Error(`Skill "${meta.name}" failed to activate.`)
        const file = await readSkill(name, path)
        signal.throwIfAborted()
        if (file.skillPath === (await realpath(meta.skillPath))) {
          return `Skill "${meta.name}" instructions are already loaded in this turn. Do not load them again through a file alias.`
        }
        const block = buildModelActivatedSkillBlock(file, meta, true)
        chargeContext(block)
        return block
      }
      if (active.size >= MAX_MODEL_ACTIVATED_SKILLS) {
        throw new Error(
          `Model skill activation limit reached (${String(MAX_MODEL_ACTIVATED_SKILLS)} per turn). Continue with the skills already loaded.`,
        )
      }
      // Reserve before I/O so parallel tool calls cannot exceed the count or load twice.
      let finish: (() => void) | undefined
      const pending = new Promise<void>((resolvePending) => {
        finish = resolvePending
      })
      active.set(meta.skillPath, pending)
      try {
        const file = await readSkill(name)
        signal.throwIfAborted()
        const current = decodeSkillDefinition(meta, file.body).validation.skill
        if (!current || current.name !== meta.name || current.disableModelInvocation) {
          throw new Error(
            `Skill "${meta.name}" is no longer eligible for model activation. Reload skill discovery after correcting its definition.`,
          )
        }
        const block = buildModelActivatedSkillBlock(file, meta)
        const bytes = chargeContext(block)
        return `${block}\n\nContext estimate: approximately ${String(Math.ceil(block.length / 4))} tokens (${String(bytes)} UTF-8 bytes); ${String(contextBytes)} skill-context bytes loaded this turn.`
      } catch (error) {
        active.delete(meta.skillPath)
        throw error
      } finally {
        finish?.()
      }
    },
  }
}

const activationTurn = new AsyncLocalStorage<SkillActivationTurn>()

export function runWithSkillActivationTurn<T>(turn: SkillActivationTurn, run: () => T): T {
  return activationTurn.run(turn, run)
}

export function getSkillActivationTurn(): SkillActivationTurn | undefined {
  return activationTurn.getStore()
}
