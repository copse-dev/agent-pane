// Named `turnStart` hooks — Milestone 0.2 of the hooks platform.
//
// These lift the inline intent-steering / prior-todos pin out of `runAgent`.
// Each hook returns `injectContext` (or abstains); the harness still owns the
// `messages[0]` string surgery that appends the merged context (M0.2 scope).
// Registration order matches the previous inline order so the assembled system
// prompt stays byte-identical.
//
// **P4 note.** The two *todos* hooks — `todoSteeringHook` and `todoPinHook` —
// have moved into the `copse.todos` first-party plugin
// (`../plugins/todos-plugin.ts`). They are still defined and exported here (the
// plugin imports them by name) so their bodies stay next to the sibling turn-start
// policies, but they are **removed from the static {@link TURN_START_HOOKS}
// list** so `createHookRegistry` does not register them a second time when the
// plugin folds its hooks in. Only the non-todos entries
// (`github-link-steering`, `commit-steering`) survive in this list; disabling
// the todos plugin therefore drops **only** the todo hooks from new work
// (decision 15 atomicity).
import type { BlockingHook } from './canonical-events.ts'
import { shouldSteerTodos, formatTodosForPrompt, TODO_STEERING_PROMPT } from '../todo-steering.ts'
import { shouldSteerGithubLinks, buildGithubLinkSteeringPrompt } from '../github-link-steering.ts'
import { shouldSteerCommit, buildCommitSteeringPrompt } from '../commit-steering.ts'
import {
  decideForcedPlanning,
  resolveForcedPlanningConfig,
  FORCED_PLANNING_PLUGIN_ID,
  PLAN_TOOL_NAME,
} from '../forced-planning.ts'

/** Todo multi-step steering block when the user message looks plan-worthy. */
export const todoSteeringHook: BlockingHook<'turnStart'> = {
  id: 'todo-steering',
  event: 'turnStart',
  run(payload) {
    if (!shouldSteerTodos(payload.userText)) return undefined
    return { injectContext: TODO_STEERING_PROMPT }
  },
}

/**
 * GitHub-link markdown steering. Resolves the repo slug via
 * {@link HookContext.resolveGithubRepoSlug} so this package never imports the
 * host's git service (execution-guidance rule 4).
 */
export const githubLinkSteeringHook: BlockingHook<'turnStart'> = {
  id: 'github-link-steering',
  event: 'turnStart',
  async run(payload, context) {
    if (!shouldSteerGithubLinks(payload.userText)) return undefined
    const repoSlug = (await context.resolveGithubRepoSlug?.()) ?? null
    return { injectContext: buildGithubLinkSteeringPrompt(repoSlug) }
  },
}

/** Prefer `git_commit` so Co-Authored-By attribution is added automatically. */
export const commitSteeringHook: BlockingHook<'turnStart'> = {
  id: 'commit-steering',
  event: 'turnStart',
  run(payload) {
    if (!shouldSteerCommit(payload.userText)) return undefined
    return { injectContext: buildCommitSteeringPrompt() }
  },
}

/**
 * Pin carried-over todos onto the system prompt. Strips the leading newlines
 * from {@link formatTodosForPrompt} so the harness's uniform
 * `content + '\n\n' + injectContext` join stays byte-identical to the old
 * inline append of the leading-newline form.
 */
export const todoPinHook: BlockingHook<'turnStart'> = {
  id: 'todo-pin',
  event: 'turnStart',
  run(payload) {
    const pinned = formatTodosForPrompt(payload.priorTodos)
    if (!pinned) return undefined
    return { injectContext: pinned.replace(/^\n+/, '') }
  },
}

/**
 * Force an explicit plan when the model running the turn measures below the
 * configured capability threshold (the `copse.forced-planning` plugin). Policy and
 * text live in `../forced-planning.ts`; this hook only supplies the turn facts
 * and its own configuration.
 *
 * Like the todos hooks it is **not** in {@link TURN_START_HOOKS} — the plugin
 * registers it, so disabling the plugin drops it from new work in one flag flip.
 *
 * The tool-availability check is deliberately conservative: with no `toolNames`
 * on the payload the hook cannot know `update_todos` is offered, so it steers
 * toward a written plan rather than risking an instruction to call a tool that
 * was filtered out of this turn's tool list.
 */
export const forcedPlanningHook: BlockingHook<'turnStart'> = {
  id: 'forced-planning',
  event: 'turnStart',
  run(payload, context) {
    const read = context.resolvePluginSetting
    const config = resolveForcedPlanningConfig(
      read ? (key: string): unknown => read(FORCED_PLANNING_PLUGIN_ID, key) : undefined,
    )
    const decision = decideForcedPlanning(
      {
        model: payload.model,
        userText: payload.userText,
        priorTodos: payload.priorTodos,
        todosToolAvailable: payload.toolNames?.includes(PLAN_TOOL_NAME) ?? false,
      },
      config,
    )
    if (!decision) return undefined
    return { injectContext: decision.prompt }
  },
}

/**
 * Turn-start hooks in the order the previous inline blocks ran. Changing this
 * order changes the assembled system prompt — treat it as a behavior change.
 *
 * The todos hooks used to sit at positions 0 and 3 here (`todoSteeringHook`,
 * `todoPinHook`) but now live inside the `copse.todos` plugin (P4). The plugin
 * registers them at the same *relative* position — first-party plugin hooks fold
 * in after the static list in `createHookRegistry`, and the plugin folds its two
 * turn-start hooks in registration order (`todoSteering` before `todoPin`),
 * matching the original layout. Removing them here is what stops the static +
 * plugin pair from double-registering (P4 trap).
 */
export const TURN_START_HOOKS: readonly BlockingHook<'turnStart'>[] = [
  githubLinkSteeringHook,
  commitSteeringHook,
]
