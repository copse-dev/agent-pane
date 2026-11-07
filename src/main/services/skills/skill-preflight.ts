import type { SkillMetadata } from '@shared/types/skills.ts'
import type {
  SkillCapabilityCheck,
  SkillCapabilityState,
  SkillExecutor,
  SkillPreflightResult,
} from '@shared/skills/skill-requirements.ts'

export interface SkillPreflightEnvironment {
  executor?: SkillExecutor
  tools?: readonly string[]
  agentState?: (name: string) => SkillCapabilityState
  dependencyState?: (parent: SkillMetadata, name: string) => SkillCapabilityState
  dependencySkill?: (parent: SkillMetadata, name: string) => SkillMetadata | null
}

/** Reviewed portable-skill adapter, replacing the former prompt-only imagegen exception. */
export function requiredSkillTools(
  skill: Pick<SkillMetadata, 'name' | 'requirements'>,
): readonly string[] {
  return [
    ...new Set([
      ...(skill.requirements?.tools ?? []),
      ...(skill.name === 'imagegen' ? ['image_gen'] : []),
    ]),
  ]
}

/** Bounded declarations and exact runtime facts; never infer dependencies or grant permissions. */
function preflightOneSkill(
  skill: SkillMetadata,
  env: SkillPreflightEnvironment = {},
): SkillPreflightResult {
  const checks: SkillCapabilityCheck[] = []
  for (const name of requiredSkillTools(skill)) {
    const state =
      env.tools === undefined ? 'untested' : env.tools.includes(name) ? 'supported' : 'unavailable'
    checks.push({
      kind: 'tool',
      name,
      state,
      reason:
        state === 'unavailable'
          ? `Required tool "${name}" is not offered in this turn. Enable its provider/plugin or choose a runner that exposes it.`
          : state === 'untested'
            ? `Required tool "${name}" has not been checked against a turn toolset.`
            : `Required tool "${name}" is offered; normal permissions still apply.`,
    })
  }
  for (const name of new Set(skill.requirements?.agents ?? [])) {
    const state = env.agentState?.(name) ?? 'untested'
    checks.push({
      kind: 'agent',
      name,
      state,
      reason:
        state === 'unavailable'
          ? `Required agent "${name}" is missing from the available agent catalog. Install its definition in an agents folder or resolve its discovery diagnostics, then reopen this workspace.`
          : state === 'disabled'
            ? `Required agent "${name}" is disabled for this turn. Choose a runner that offers task delegation to this agent.`
            : `Required agent "${name}": ${state}. Agent availability does not verify model compatibility.`,
    })
  }
  for (const name of new Set(skill.dependencies ?? [])) {
    const state = env.dependencyState?.(skill, name) ?? 'untested'
    checks.push({
      kind: 'dependency',
      name,
      state,
      reason:
        state === 'disabled'
          ? `Dependency "${name}" is disabled. Enable its skill source/plugin in Settings → Customise, then reload Sources.`
          : state === 'unavailable'
            ? `Dependency "${name}" is missing or outside this workflow's source/plugin container. Restore the declared sibling and reload Sources.`
            : `Dependency "${name}": ${state}. Loading still requires the dependency authorization policy.`,
    })
  }
  const executors = skill.requirements?.executors
  if (executors) {
    const state =
      env.executor === undefined
        ? 'untested'
        : executors.includes(env.executor)
          ? 'supported'
          : 'unsupported'
    checks.push({
      kind: 'executor',
      name: env.executor ?? 'unselected',
      state,
      reason:
        state === 'unsupported'
          ? `Executor "${env.executor ?? ''}" is excluded by this skill. Choose one of: ${executors.join(', ')}.`
          : state === 'untested'
            ? `Executor restrictions not checked. Declared executors: ${executors.join(', ')}.`
            : `Executor "${env.executor ?? ''}" is declared; end-to-end compatibility remains untested.`,
    })
  }
  for (const name of skill.missingReferences)
    checks.push({
      kind: 'supporting-file',
      name,
      state: 'unavailable',
      reason: `Supporting file "${name}" is missing. The skill still loads; continue without it and report the broken skill.`,
    })
  return preflightResult(checks)
}

function preflightResult(checks: SkillCapabilityCheck[]): SkillPreflightResult {
  return {
    // Supporting-file paths are inferred from SKILL.md prose, so a miss warns but never blocks.
    status: checks.some(
      (check) =>
        check.kind !== 'supporting-file' &&
        (check.state === 'unavailable' ||
          check.state === 'disabled' ||
          check.state === 'unsupported'),
    )
      ? 'blocked'
      : 'untested',
    checks,
  }
}

/** Inspect declared metadata, deduplicating cycles without loading or authorizing files. */
export function preflightSkill(
  skill: SkillMetadata,
  env: SkillPreflightEnvironment = {},
): SkillPreflightResult {
  const checks: SkillCapabilityCheck[] = []
  const seen = new Set([skill.skillPath])
  const pending = [skill]
  // Bound inspection to one root plus sixteen dependencies. This is diagnostic,
  // not authority accounting: explicit invocations can satisfy more of the graph.
  const maxSkills = 17
  for (const current of pending) {
    const result = preflightOneSkill(current, env)
    checks.push(
      ...result.checks.map((check) =>
        current.skillPath === skill.skillPath
          ? check
          : { ...check, reason: `Dependency skill "${current.name}": ${check.reason}` },
      ),
    )
    for (const name of current.dependencies ?? []) {
      if (env.dependencyState?.(current, name) !== 'supported') continue
      const dependency = env.dependencySkill?.(current, name)
      if (!dependency || seen.has(dependency.skillPath)) continue
      if (seen.size >= maxSkills) {
        checks.push({
          kind: 'dependency',
          name,
          state: 'untested',
          reason:
            'Preflight reached its sixteen-dependency inspection limit; further declarations are untested. Split this workflow into smaller invocations or explicitly invoke additional skills.',
        })
        return preflightResult(checks)
      }
      seen.add(dependency.skillPath)
      pending.push(dependency)
    }
  }
  return preflightResult(checks)
}

export function skillPreflightNotice(
  skill: SkillMetadata,
  env: SkillPreflightEnvironment = {},
): string {
  const result = preflightSkill(skill, env)
  const details = result.checks
    .filter((check) => check.state !== 'supported')
    .map((check) => `${check.state}: ${check.reason}`)
  return [
    `Skill preflight for "${skill.name}": ${result.status}.`,
    ...(result.status === 'blocked'
      ? ['Do not start this workflow until these blockers are resolved.']
      : []),
    ...details,
    'Workflow/model compatibility is untested. Declarations grant no permissions.',
  ].join('\n')
}
