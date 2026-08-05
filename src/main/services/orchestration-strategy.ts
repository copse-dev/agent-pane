import { getModelInfo } from '@copse/llm/model-catalog.ts'
import { BEST_VALUE_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'

/**
 * Experimental, opt-in "orchestration strategy" feature — the counterpart of the
 * advisor strategy (advisor-strategy.ts). Where the advisor pattern keeps the
 * everyday loop on a cheap executor and pulls a *stronger* model in for
 * guidance, the orchestration pattern inverts the roles: the chat model stays
 * the **orchestrator** (planning, reviewing, integrating) and delegates each
 * bounded implementation step to a **cheaper / faster worker model** running as
 * a subagent with implementation tools. The orchestrator observes between
 * steps — every `delegate_step` result carries the worker's report plus a
 * working-tree snapshot, so the parent reviews what actually changed before
 * delegating the next step.
 *
 * Unlike the advisor (which is handed the full transcript automatically), the
 * worker sees *only* the brief the orchestrator writes: the step, the curated
 * context, and the expected outcome. Curating context is the orchestrator's
 * job — it is what keeps the worker's window small and the delegation cheap.
 *
 * This module is pure (no I/O, no settings read). The run-scoped subagent call
 * lives in orchestration-runner.ts, and the tool gating lives in
 * registry-bootstrap.
 */

export const ORCHESTRATION_STRATEGY_ENABLED_SETTING = 'orchestrationStrategyEnabled'
export const ORCHESTRATION_WORKER_MODEL_SETTING = 'orchestrationWorkerModel'

/**
 * Default worker selection when the strategy is enabled. A rule rather than a
 * pinned id (see `@copse/llm/dynamic-model.ts`): the worker's job is to be the
 * cheap half of the pairing, and which model that is depends on what the user
 * has configured — best value is that judgement, re-derived per delegation.
 */
export const DEFAULT_ORCHESTRATION_WORKER_MODEL = BEST_VALUE_MODEL_SELECTOR

/**
 * Per-step loop budget for the worker. One delegated step is read → edit →
 * verify, not a whole feature; a worker that needs more than this is a sign
 * the orchestrator's step was too big, and the truncated report tells it so.
 */
export const ORCHESTRATION_WORKER_MAX_STEPS = 16

/**
 * Implementation tools the worker subagent may use: reads/searches to ground
 * itself, file mutations to implement the step, run_shell to verify, and git
 * *inspection* to see its own changes. Deliberately excludes git_commit (the
 * orchestrator owns integration), the subagent entry points (explore /
 * investigate_ci — no nesting), and ask_user (the worker reports mismatches
 * back to the orchestrator instead of interrogating the user).
 */
export const ORCHESTRATION_WORKER_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
  'write_file',
  'str_replace',
  'delete_file',
  'rename_file',
  'make_directory',
  'run_shell',
  'git_status',
  'git_diff',
] as const

export const ORCHESTRATION_WORKER_SYSTEM_PROMPT = `You are an implementation worker for a coding assistant.

A stronger orchestrator model has broken the task into steps and delegated exactly one step to you, together with the context you need. You do not see the wider conversation — the brief below is your whole world.

Rules:
- Implement ONLY the delegated step. Do not expand scope, refactor opportunistically, or start the next step.
- Read the files you are about to change first (read_file / search_codebase); never assume content the brief did not include.
- Use str_replace for surgical edits and write_file for full rewrites; use run_shell for the builds/tests the step calls for.
- Do not commit, push, or change version-control state — git_status and git_diff are for inspecting your own work only.
- If the brief is insufficient or contradicts what you find in the code, stop and report the mismatch instead of guessing.
- Finish with a concise report for the orchestrator: what you changed (file paths), how you verified it, and anything the next step needs to know.`

export interface WorkerStepBrief {
  /** The single implementation step to complete now. */
  step: string
  /** Curated context from the orchestrator — the worker sees nothing else. */
  context: string
  /** Optional definition of done (behavior to verify, commands that should pass). */
  expectedOutcome?: string | undefined
  /** Workspace root, so relative paths in the brief resolve unambiguously. */
  workspace: string
}

/**
 * Format the orchestrator's brief as the worker's user task. Pure and
 * deterministic so it is easy to unit-test. Deliberately does NOT include the
 * conversation transcript — curating context is the orchestrator's job and is
 * what keeps the worker call cheap (contrast buildAdvisorTranscript, where the
 * advisor reads everything).
 */
export function buildWorkerTask(brief: WorkerStepBrief): string {
  const parts = [
    `# Delegated step\n${brief.step.trim()}`,
    `# Context from the orchestrator\n${brief.context.trim()}`,
  ]
  const outcome = brief.expectedOutcome?.trim()
  if (outcome) parts.push(`# Expected outcome\n${outcome}`)
  parts.push(
    `Workspace: ${brief.workspace}`,
    'Implement this step now, then finish with your report for the orchestrator.',
  )
  return parts.join('\n\n')
}

/**
 * Compose what the orchestrator observes after a step: the worker's report
 * plus a snapshot of the working tree, so the parent can judge what actually
 * changed (and dig in with git_diff) before delegating the next step.
 */
export function buildStepObservation(opts: { report: string; workingTree: string }): string {
  const report = opts.report.trim() || 'Worker returned no report.'
  const tree = opts.workingTree.trim()
  if (!tree) return report
  return `${report}\n\n---\nWorking tree after this step (git status --short):\n${tree}`
}

export interface OrchestrationPairAssessment {
  /** Whether to allow the pairing at all (permissive, like the advisor). */
  ok: boolean
  /** Human-readable note for the settings UI. */
  reason: string
}

/**
 * Assess an (orchestrator, worker) pairing. Permissive by design — the only
 * pairing we refuse is delegating to the *same* model, which adds a hop with no
 * cost or speed win. A worker that is not actually cheaper (per the model
 * catalog) still works, but the UI can warn that the pattern buys no savings.
 * Unknown models (e.g. local ones) are assumed cheaper — a local worker costs
 * nothing per token, which is exactly the pairing this strategy is for.
 */
export function validateOrchestrationPair(
  orchestratorModel: string,
  workerModel: string,
): OrchestrationPairAssessment {
  if (orchestratorModel === workerModel) {
    return {
      ok: false,
      reason:
        'Worker and orchestrator are the same model — delegation adds a hop without any cost or speed win.',
    }
  }
  const orchestrator = getModelInfo(orchestratorModel)
  const worker = getModelInfo(workerModel)
  if (orchestrator && worker && worker.outputPricePerMTok >= orchestrator.outputPricePerMTok) {
    return {
      ok: true,
      reason:
        'Worker is not cheaper than the orchestrator — the pattern still works but buys no savings.',
    }
  }
  return {
    ok: true,
    reason: 'Orchestrator plans and reviews; the cheaper worker implements each delegated step.',
  }
}
