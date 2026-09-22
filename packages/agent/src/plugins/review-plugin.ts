// The `copse.review` first-party plugin — Copse Reviewer's app shell
// (docs/plans/copse-reviewer.md, Phase 3). It replaces the P5-era
// `copse.model-comparison` plugin: where that ran two models over the working
// diff and had a judge compare their prose, this runs `@copse/review`'s
// pipeline — Stage 0's build and test delta, models × lenses with brokered
// tools, clustering, verification by reproducer and challenger — and surfaces
// findings, not paragraphs.
//
// The plugin declares the `review_changes` native tool (registered host-side
// in `registry-bootstrap.ts` through `syncReviewTools`) and the "Review
// changes" follow-up bubble. The gesture the plan calls for — "Review" in the
// Changes view — is a level-3 renderer contribution (`git-changes-pane.ts`)
// gated on this plugin being enabled, read through `plugins:list` like the
// other plugin-gated pane controls. One Settings > Plugins flag flip drops
// the tool, the bubble and the button together (decision 15); a report
// already on a thread keeps rendering (decision 17).
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring
// (the tool registration + live sync, the review service) reads the plugin
// registry via the shared `getDefaultPluginRegistry()` seam.
import { BEST_INTELLECT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const REVIEW_PLUGIN_ID = 'copse.review'

/** The plugin this one replaced; its persisted state is migrated once by the host. */
export const RETIRED_MODEL_COMPARISON_PLUGIN_ID = 'copse.model-comparison'

/** The native tool name the plugin contributes while enabled. */
export const REVIEW_TOOL_NAME = 'review_changes'

/**
 * Id of the follow-up bubble the plugin suggests above the composer. A review
 * spends model calls and can execute the repository's own build and tests, so
 * it is offered, never forced: the bubble sits beside "Changes" until someone
 * wants it, and the click is the decision (see `review-service.ts`).
 */
export const REVIEW_FOLLOW_UP_ID = 'review-changes'

/**
 * Plugin-scoped setting ids. `reviewerModel` blank means the model the chat is
 * running on; `challengerModel` is the model that tries to refute each finding
 * and writes reproducers, defaulting to a *rule* rather than a pinned id.
 */
export const REVIEWER_MODEL_SETTING_ID = 'reviewerModel'
export const CHALLENGER_MODEL_SETTING_ID = 'challengerModel'
export const REVIEW_LENSES_SETTING_ID = 'lenses'
export const REVIEW_VERIFY_SETTING_ID = 'verify'

/** Default challenger selection: reach for the most capable model the user can run. */
export const DEFAULT_CHALLENGER_MODEL_ID = BEST_INTELLECT_MODEL_SELECTOR

/**
 * The lens choices the Settings field offers. `correctness` is the reviewer's
 * default (bugs and regressions, B4); `all` runs every lens the package ships.
 */
export const REVIEW_LENS_CHOICES = ['correctness', 'all'] as const
export type ReviewLensChoice = (typeof REVIEW_LENS_CHOICES)[number]
export const DEFAULT_REVIEW_LENS_CHOICE: ReviewLensChoice = 'correctness'

export const reviewPlugin: RegisteredPlugin = definePlugin(
  {
    name: REVIEW_PLUGIN_ID,
    description:
      'Copse Reviewer — builds and tests your changes against their base, has a model review them under a lens, and tries to refute every finding before it reaches you. On demand from the Changes view, the "Review changes" bubble, or the `review_changes` tool.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: [REVIEW_TOOL_NAME] },
    // Offered only when the working tree has uncommitted changes: with a clean
    // tree on its base branch there is nothing to review.
    followUps: [
      {
        id: REVIEW_FOLLOW_UP_ID,
        label: 'Review changes',
        action: 'review',
        when: 'workspace-changes',
      },
    ],
    settings: {
      [REVIEWER_MODEL_SETTING_ID]: {
        kind: 'model',
        title: 'Reviewer',
        description:
          'How to choose the model that reads the change and reports findings. Leave unset to review with the model this chat is already on.',
      },
      [CHALLENGER_MODEL_SETTING_ID]: {
        kind: 'model',
        title: 'Challenger',
        description:
          'How to choose the model that tries to refute each finding and writes the reproducing test. A different family from the reviewer catches more.',
        default: DEFAULT_CHALLENGER_MODEL_ID,
      },
      [REVIEW_LENSES_SETTING_ID]: {
        kind: 'enum',
        title: 'Lenses',
        description:
          'Which briefs the reviewer runs under: bugs and regressions only, or every lens (contracts, tests, security, concurrency too). More lenses cost more calls.',
        options: [...REVIEW_LENS_CHOICES],
        default: DEFAULT_REVIEW_LENS_CHOICE,
      },
      [REVIEW_VERIFY_SETTING_ID]: {
        kind: 'boolean',
        title: 'Verify findings',
        description:
          'Run the challenger over every finding and, where a test can show it, a reproducer on head and base. Off reports the unverified candidates as such.',
        default: true,
      },
    },
    storage: { namespace: REVIEW_PLUGIN_ID },
  },
  {
    toolNames: [REVIEW_TOOL_NAME],
    followUps: [
      {
        id: REVIEW_FOLLOW_UP_ID,
        label: 'Review changes',
        action: 'review',
        when: 'workspace-changes',
      },
    ],
  },
)
