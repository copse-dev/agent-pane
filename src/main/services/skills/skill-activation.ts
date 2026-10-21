import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SkillMetadata } from '@shared/types/skills.ts'
import type { SkillExecutor } from '@shared/skills/skill-requirements.ts'
import {
  getSkill,
  listSkillSources,
  readSkill,
  skillPreflightEnvironment,
} from './skills-registry.ts'
import {
  buildModelActivatedSkillBlock,
  modelInvocableSkillsForTools,
  skillHasRequiredTools,
} from './skill-prompt.ts'
import { isSkillDependencyInScope } from './skill-dependencies.ts'
import { preflightSkill, skillPreflightNotice } from './skill-preflight.ts'
import { decodeSkillDefinition } from './parse-skill-frontmatter.ts'

export const MAX_MODEL_ACTIVATED_SKILLS = 4
export const MAX_WORKFLOW_DEPENDENCY_SKILLS = 16
export const MAX_MODEL_SKILL_CONTEXT_BYTES = 128 * 1024

export interface SkillActivationTurn {
  read(name: string, path: string | undefined, signal: AbortSignal): Promise<string>
}

/** Run-owned state. An omitted executor fact stays untested rather than implying native. */
export function createSkillActivationTurn(
  invokedSkills: readonly string[],
  availableToolNames: readonly string[],
  invokedSkillContextBytes = 0,
  executor?: SkillExecutor,
): SkillActivationTurn {
  const eligible = new Map(
    modelInvocableSkillsForTools(availableToolNames, executor).map((skill) => [
      skill.name,
      skill.skillPath,
    ]),
  )
  const manual = new Set(
    invokedSkills.flatMap((name) => {
      const skill = getSkill(name)
      return skill && skill.userInvocable !== false ? [skill.skillPath] : []
    }),
  )
  // Freeze winner identities and declarations. Discovery changes cannot redirect a grant.
  const snapshot = new Map(
    listSkillSources().skills.map((meta) => [
      meta.name,
      {
        ...meta,
        dependencies: [...(meta.dependencies ?? [])],
      },
    ]),
  )
  const dependencyParents = new Map<string, SkillMetadata>()
  const dependencyErrors = new Map<string, string>()
  const dependencies = new Set<string>()
  const active = new Map<string, Promise<void>>()
  let initializing: Promise<void> | undefined

  function declareDependencies(parent: SkillMetadata): void {
    for (const name of parent.dependencies ?? []) {
      const candidate = snapshot.get(name)
      if (candidate && isSkillDependencyInScope(parent, candidate)) {
        if (!manual.has(candidate.skillPath) && !dependencyParents.has(candidate.skillPath))
          dependencyParents.set(candidate.skillPath, parent)
      } else {
        dependencyErrors.set(
          name,
          `Declared dependency "${name}" of "${parent.name}" is unavailable in the same skill container, source and plugin. Enable/reload the intended bundle or correct its declaration; no shadowed or cross-scope fallback is allowed.`,
        )
      }
    }
  }

  async function validateDefinition(meta: SkillMetadata): Promise<void> {
    const currentMeta = getSkill(meta.name)
    if (
      !currentMeta ||
      currentMeta.skillPath !== meta.skillPath ||
      !isSkillDependencyInScope(meta, currentMeta)
    )
      throw new Error(
        `Workflow skill "${meta.name}" is no longer available. Reload skills before continuing.`,
      )
    const file = await readSkill(meta.name)
    const current = decodeSkillDefinition(meta, file.body).validation.skill
    if (
      !current ||
      current.name !== meta.name ||
      (manual.has(meta.skillPath) && !current.userInvocable) ||
      file.skillPath !== (await realpath(meta.skillPath)) ||
      JSON.stringify(current.dependencies ?? []) !== JSON.stringify(meta.dependencies ?? [])
    )
      throw new Error(
        `Workflow skill "${meta.name}" changed its dependency declaration. Reload skills before continuing.`,
      )
  }

  async function initializeDependencies(): Promise<void> {
    initializing ??= Promise.all(
      [...snapshot.values()]
        .filter((meta) => manual.has(meta.skillPath) && meta.dependencies.length > 0)
        .map(async (meta) => {
          try {
            await validateDefinition(meta)
            declareDependencies(meta)
          } catch (error) {
            for (const name of meta.dependencies) dependencyErrors.set(name, String(error))
          }
        }),
    ).then(() => {})
    await initializing
  }
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
      const environment = skillPreflightEnvironment(availableToolNames, executor)
      if (preflightSkill(meta, environment).status === 'blocked')
        throw new Error(skillPreflightNotice(meta, environment))
      const manuallyInvoked = manual.has(meta.skillPath)
      await initializeDependencies()
      signal.throwIfAborted()
      const parent = dependencyParents.get(meta.skillPath)
      const captured = snapshot.get(meta.name)
      const dependency =
        !manuallyInvoked &&
        parent !== undefined &&
        captured?.skillPath === meta.skillPath &&
        isSkillDependencyInScope(parent, meta)
      if (dependency) {
        // A live registry replacement or realpath escape must never inherit a grant.
        let ancestor: SkillMetadata | undefined = parent
        while (ancestor) {
          signal.throwIfAborted()
          await validateDefinition(ancestor)
          ancestor = dependencyParents.get(ancestor.skillPath)
        }
        const [parentRoot, childRoot] = await Promise.all([
          realpath(parent.skillRoot),
          realpath(meta.skillRoot),
        ])
        signal.throwIfAborted()
        if (dirname(parentRoot) !== dirname(childRoot))
          throw new Error(
            `Declared dependency "${meta.name}" resolves outside the workflow's skill container.`,
          )
        if (!skillHasRequiredTools(meta.name, availableToolNames))
          throw new Error(
            `Declared dependency "${meta.name}" requires tools unavailable in this turn.`,
          )
      }
      if (
        !manuallyInvoked &&
        !dependency &&
        (meta.disableModelInvocation || eligible.get(meta.name) !== meta.skillPath)
      ) {
        throw new Error(
          dependencyErrors.get(meta.name) ??
            `Skill "${meta.name}" is not eligible for model activation in this turn. It is neither model-invocable nor an authorized declared workflow dependency.`,
        )
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
        signal.throwIfAborted()
        if (active.get(meta.skillPath) !== prior)
          throw new Error(
            `Skill "${meta.name}" failed to activate. Retry only after resolving the earlier error.`,
          )
        if (dependency) {
          await validateDefinition(captured)
          signal.throwIfAborted()
          declareDependencies(captured)
        }
        return `Skill "${meta.name}" is already active in this turn. Use its loaded instructions; do not activate it again.`
      }
      if (!instructions) {
        if (prior) await prior
        signal.throwIfAborted()
        if (!manuallyInvoked && active.get(meta.skillPath) !== prior)
          throw new Error(`Skill "${meta.name}" failed to activate.`)
        const file = await readSkill(name, path)
        signal.throwIfAborted()
        const live = getSkill(meta.name)
        if (
          !live ||
          live.skillPath !== meta.skillPath ||
          file.skillRoot !== meta.skillRoot ||
          !isSkillDependencyInScope(meta, live)
        )
          throw new Error(
            `Skill "${meta.name}" changed its registry identity. Reload skills before continuing.`,
          )
        const instructionsPath = await realpath(meta.skillPath)
        signal.throwIfAborted()
        if (file.skillPath === instructionsPath) {
          return `Skill "${meta.name}" instructions are already loaded in this turn. Do not load them again through a file alias.`
        }
        signal.throwIfAborted()
        const instructionsBlock = buildModelActivatedSkillBlock(
          file,
          meta,
          true,
          dependency ? parent.name : undefined,
        )
        const block = `${instructionsBlock}\n\n${skillPreflightNotice(meta, environment)}`
        chargeContext(block)
        return block
      }
      if (dependency && dependencies.size >= MAX_WORKFLOW_DEPENDENCY_SKILLS)
        throw new Error(
          `Workflow dependency activation limit reached (${String(MAX_WORKFLOW_DEPENDENCY_SKILLS)} per turn). Continue with the skills already loaded.`,
        )
      if (!dependency && active.size - dependencies.size >= MAX_MODEL_ACTIVATED_SKILLS) {
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
      if (dependency) dependencies.add(meta.skillPath)
      try {
        const file = await readSkill(name)
        signal.throwIfAborted()
        const live = getSkill(meta.name)
        if (
          !live ||
          live.skillPath !== meta.skillPath ||
          !isSkillDependencyInScope(meta, live) ||
          file.skillPath !== (await realpath(meta.skillPath))
        )
          throw new Error(
            `Skill "${meta.name}" changed its registry identity. Reload skills before continuing.`,
          )
        signal.throwIfAborted()
        const current = decodeSkillDefinition(meta, file.body).validation.skill
        if (
          !current ||
          current.name !== meta.name ||
          (!dependency && current.disableModelInvocation) ||
          (dependency &&
            JSON.stringify(current.dependencies ?? []) !== JSON.stringify(captured.dependencies))
        ) {
          throw new Error(
            `Skill "${meta.name}" is no longer eligible for model activation. Reload skill discovery after correcting its definition.`,
          )
        }
        const currentMeta = { ...meta, requirements: current.requirements ?? {} }
        if (preflightSkill(currentMeta, environment).status === 'blocked') {
          throw new Error(skillPreflightNotice(currentMeta, environment))
        }
        const instructionsBlock = buildModelActivatedSkillBlock(
          file,
          meta,
          false,
          dependency ? parent.name : undefined,
        )
        const block = `${instructionsBlock}\n\n${skillPreflightNotice(currentMeta, environment)}`
        const bytes = chargeContext(block)
        if (dependency) declareDependencies(captured)
        return `${block}\n\nContext estimate: approximately ${String(Math.ceil(block.length / 4))} tokens (${String(bytes)} UTF-8 bytes); ${String(contextBytes)} skill-context bytes loaded this turn.`
      } catch (error) {
        active.delete(meta.skillPath)
        dependencies.delete(meta.skillPath)
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
