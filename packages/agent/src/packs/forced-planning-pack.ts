// The `copse.forced-planning` first-party pack.
//
// Bundles the experimental "make weaker models plan first" feature behind a
// single lifecycle flag. The pack contributes exactly one thing: the
// `forced-planning` turn-start hook, which measures the capability of the model
// running the turn and — below the configured threshold — injects a mandatory
// plan-first steering block (`update_todos` when that tool is offered, a written
// numbered plan when it is not).
//
// Why a pack and not a top-level setting: the feature is a bundle of
// contributions (a hook, its steering text, and its own configuration schema)
// whose only sensible master switch is one flag. Disabling it drops the hook
// from the assembly pipeline in one atomic flip (decision 15) and the assembled
// system prompt goes back to byte-identical.
//
// **Default off.** The pack changes the system prompt of every turn on a weaker
// model, so it ships disabled and is opted into from Settings → Packs. The
// registry itself enables every registered pack (VS Code's built-in-extension
// model), so the off-by-default set is declared host-side in
// `DEFAULT_DISABLED_PACK_IDS` (`src/main/services/packs/pack-service.ts`) and
// seeded into `packDisabled` on a profile that has never had one.
//
// **Depends on facts, not on the todos pack.** The steering names `update_todos`
// only when the host reports it in the turn's tool list (`TurnStartPayload.toolNames`),
// so disabling `copse.todos` — or running read-only — downgrades this pack to a
// written plan instead of instructing the model to call a tool that isn't there.
//
// Electron-free (execution-guidance rule 4): pure declarations plus one typed
// function hook. The hook reads its pack settings through the host-injected
// `HookContext.resolvePackSetting` seam — never by importing the pack service.
import { definePack, type RegisteredPack } from './pack-manifest.ts'
import { forcedPlanningHook } from '../hooks/turn-start-hooks.ts'
import {
  CANONICAL_THRESHOLD_SETTING,
  COMPOSITE_THRESHOLD_SETTING,
  DEFAULT_CANONICAL_INTELLECT_THRESHOLD,
  DEFAULT_COMPOSITE_INTELLECT_THRESHOLD,
  DEFAULT_FORCED_PLANNING_CONFIG,
  FORCED_PLANNING_PACK_ID,
  UNMEASURED_MODEL_POLICIES,
  UNMEASURED_MODELS_SETTING,
} from '../forced-planning.ts'

export { FORCED_PLANNING_PACK_ID }

/**
 * The `copse.forced-planning` pack: the turn-start hook plus the pack-scoped
 * thresholds Settings renders generically from this schema. No tools, no prompt
 * blocks (the steering is conditional, so it is injected by the hook rather than
 * appended to every system prompt) and no UI contributions.
 */
export const forcedPlanningPack: RegisteredPack = definePack(
  {
    name: FORCED_PLANNING_PACK_ID,
    description:
      'Forced planning — when the model running a turn measures below a capability threshold, require an explicit plan (`update_todos`, or a written numbered plan when that tool is unavailable) before it touches any other tool, so smaller and heavily-quantized models can carry longer tasks.',
    trust: 'first-party',
    settings: {
      [CANONICAL_THRESHOLD_SETTING]: {
        kind: 'number',
        title: 'Plan below this Intelligence Index score',
        description:
          'Artificial Analysis Intelligence Index (canonical scale — frontier models sit around 55–60, Claude Haiku 4.5 at 24). Models measured below this must plan first.',
        default: DEFAULT_CANONICAL_INTELLECT_THRESHOLD,
      },
      [COMPOSITE_THRESHOLD_SETTING]: {
        kind: 'number',
        title: 'Plan below this composite score',
        description:
          'Copse composite scale (0–100 benchmark mean) — used for local weights that Artificial Analysis has not measured. The two scales are not comparable, which is why each has its own threshold.',
        default: DEFAULT_COMPOSITE_INTELLECT_THRESHOLD,
      },
      [UNMEASURED_MODELS_SETTING]: {
        kind: 'enum',
        title: 'Models with no measurement',
        description:
          'What to do when the running model has no sourced score on either scale: skip (leave the turn untouched) or plan (assume it needs one).',
        default: DEFAULT_FORCED_PLANNING_CONFIG.unmeasured,
        options: UNMEASURED_MODEL_POLICIES,
      },
    },
    storage: { namespace: FORCED_PLANNING_PACK_ID },
  },
  {
    blockingHooks: [forcedPlanningHook],
  },
)
