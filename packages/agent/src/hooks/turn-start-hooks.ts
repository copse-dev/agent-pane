// Named `turnStart` hooks — Milestone 0.2 of the hooks platform.
//
// These lift the inline intent-steering / prior-todos pin out of `runAgent`.
// Each hook returns `injectContext` (or abstains); the harness still owns the
// `messages[0]` string surgery that appends the merged context (M0.2 scope).
// Registration order matches the previous inline order so the assembled system
// prompt stays byte-identical.
//
// **P4 note.** The two *todos* hooks — `todoSteeringHook` and `todoPinHook` —
// have moved into the `copse.todos` first-party pack
// (`../packs/todos-pack.ts`). They are still defined and exported here (the
// pack imports them by name) so their bodies stay next to the sibling turn-start
// policies, but they are **removed from the static {@link TURN_START_HOOKS}
// list** so `createHookRegistry` does not register them a second time when the
// pack folds its hooks in. Only the non-todos entries
// (`github-link-steering`) survive in this list; disabling the todos pack
// therefore drops **only** the todo hooks from new work (decision 15
// atomicity).
import type { BlockingHook } from './canonical-events.ts'
import { shouldSteerTodos, formatTodosForPrompt, TODO_STEERING_PROMPT } from '../todo-steering.ts'
import { shouldSteerGithubLinks, buildGithubLinkSteeringPrompt } from '../github-link-steering.ts'
import {
  decideForcedPlanning,
  resolveForcedPlanningConfig,
  FORCED_PLANNING_PACK_ID,
  PLAN_TOOL_NAME,
} from '../forced-planning.ts'
import {
  shouldSteerSiteBuilding,
  SITE_BUILDING_STEERING_PROMPT,
} from '../site-building-steering.ts'

/** Todo multi-step steering block when the user message looks plan-worthy. */
export const todoSteeringHook: BlockingHook<'turnStart'> = {
  id: 'todo-steering',
  event: 'turnStart',
  run(payload) {
    // ACP owns its own orchestration loop and Copse deliberately does not
    // bridge update_todos. Preserve the pre-ACP-hook behavior instead of
    // instructing that executor to call a tool it cannot see.
    if (payload.executor === 'acp') return undefined
    if (!shouldSteerTodos(payload.userText)) return undefined
    return { injectContext: TODO_STEERING_PROMPT }
  },
}

/**
 * Product-quality steering for requests that ask Copse to build a website.
 * The detector and prompt are intentionally brand-agnostic: the user's brief
 * owns the visual direction; the pack supplies a reliable design/build/verify
 * workflow to both local and ACP executors.
 */
export const siteBuildingSteeringHook: BlockingHook<'turnStart'> = {
  id: 'site-building-steering',
  event: 'turnStart',
  run(payload) {
    if (!shouldSteerSiteBuilding(payload.userText)) return undefined
    return { injectContext: SITE_BUILDING_STEERING_PROMPT }
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
 * configured capability threshold (the `copse.forced-planning` pack). Policy and
 * text live in `../forced-planning.ts`; this hook only supplies the turn facts
 * and its own configuration.
 *
 * Like the todos hooks it is **not** in {@link TURN_START_HOOKS} — the pack
 * registers it, so disabling the pack drops it from new work in one flag flip.
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
    const read = context.resolvePackSetting
    const config = resolveForcedPlanningConfig(
      read ? (key: string): unknown => read(FORCED_PLANNING_PACK_ID, key) : undefined,
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
 * `todoPinHook`) but now live inside the `copse.todos` pack (P4). The pack
 * registers them at the same *relative* position — first-party pack hooks fold
 * in after the static list in `createHookRegistry`, and the pack folds its two
 * turn-start hooks in registration order (`todoSteering` before `todoPin`),
 * matching the original layout. Removing them here is what stops the static +
 * pack pair from double-registering (P4 trap).
 */
export const TURN_START_HOOKS: readonly BlockingHook<'turnStart'>[] = [githubLinkSteeringHook]
