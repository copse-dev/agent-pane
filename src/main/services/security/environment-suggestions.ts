import {
  AUTO_APPROVAL_LEVEL_LABELS,
  AUTO_APPROVAL_LEVELS,
  AUTO_APPROVAL_RANK,
  autoApprovalLevelAllows,
  type AutoApprovalLevel,
  type AutoApprovalTier,
} from '@shared/auto-approval.ts'
import type { EnvironmentSuggestionKind } from '@shared/environment-setup.ts'
import { redactSecrets } from '@shared/threads/decision-log.ts'
import type { PromptCause } from '@shared/threads/prompt-cause.ts'
import { commandPackageRegistries, sshDestinationHosts } from '@copse/shell-guard/host-reach.ts'
import { assessAutoApproval } from './auto-approval.ts'
import { resolveCommandRouting, trustableCommandHead } from './command-routing.ts'
import { assessShellHarm, type ShellHarmContext } from './shell-harm.ts'

/**
 * Environment setup's suggestion builder (`docs/plans/environment-setup.md`).
 *
 * Every suggestion is a counterfactual over the user's own answers: for each
 * prompt a person answered, re-run the deterministic rule that raised it with one
 * candidate setting added, and keep the candidate only when the prompt would not
 * have happened. Nothing here reads repository content or asks a model, so a
 * cloned repo cannot talk its way into a suggestion, and a suggestion can never
 * do more than the same value typed into Settings → Permissions by hand.
 *
 * Pure: the store reads and the host probes are the caller's.
 */

/** One answered prompt, joined to the command it was about when there was one. */
export interface PromptEvidence {
  at: number
  threadId: string
  verdict: 'approved' | 'denied'
  /** Decision domain: `shell`, `web`, … */
  kind: string
  cause?: PromptCause
  /** The decision subject: an origin for web prompts, a placeholder for shell. */
  subject: string
  /** The shell command the prompt was about, from the thread's tool call. */
  command?: string
}

export interface SuggestionContext {
  workspaceRoot: string | null
  sandboxActive: boolean
  autoApprovalLevel: AutoApprovalLevel
  configuredRemotes: ReadonlySet<string>
  trustedCommands: ReadonlySet<string>
  trustedSshHosts: readonly string[]
  trustedPackageRegistries: readonly string[]
  /** The effective web allow-list, defaults included. */
  webAllowedOrigins: readonly string[]
  /** The harm gate's host probes, minus the trusted hosts this module varies. */
  harm: Omit<ShellHarmContext, 'trustedSshHosts' | 'trustedPackageRegistries'>
  /** Returns the canonical origin, or null when the settings validator refuses it. */
  normalizeOrigin: (origin: string) => string | null
}

export interface DraftSuggestion {
  kind: EnvironmentSuggestionKind
  value: string
  label: string
  risk: string
  approvals: number
  threads: number
  lastAt: number
  examples: string[]
  checked: boolean
  declined: boolean
}

/** A candidate must clear this many approvals, from at least this many threads. */
export const MIN_APPROVALS = 3
export const MIN_THREADS = 2
/** At this many approvals (and no refusals) a low-risk item starts ticked. */
export const PRECHECK_APPROVALS = 5

const MAX_EXAMPLES = 3
const MAX_EXAMPLE_LENGTH = 160

/** Prompts the auto-approval classifier is consulted on before they open. */
const AUTO_APPROVAL_CAUSES: ReadonlySet<PromptCause> = new Set([
  'shell-sandbox-escalation',
  'shell-sandbox-retry',
  'shell-expected-sandbox-block',
  'shell-in-sandbox',
])

/** Prompts that asked to run a command outside the sandbox: what a trusted command skips. */
const ESCALATION_CAUSES: ReadonlySet<PromptCause> = new Set([
  'shell-sandbox-escalation',
  'shell-sandbox-retry',
  'shell-expected-sandbox-block',
])

const TRUSTED_COMMAND_RISK =
  'Runs outside the project sandbox, with your account’s files and network, in trusted projects with auto-run on.'
const WEB_ORIGIN_RISK = 'The agent can fetch pages from this origin without asking.'
const REGISTRY_RISK =
  'Under Guarded YOLO, installs from this registry run without asking. Its packages can run code when installed.'
const SSH_HOST_RISK =
  'Under Guarded YOLO, trusting a host hands it commands as if it were this machine, including reads of its secrets.'

function autoApprovalRisk(level: AutoApprovalLevel): string {
  const hooks =
    AUTO_APPROVAL_RANK[level] >= AUTO_APPROVAL_RANK['local-write']
      ? ' These run repository git hooks.'
      : ''
  return `Recognised command shapes run without asking, outside the sandbox when they need the network.${hooks}`
}

function exampleText(text: string): string {
  const redacted = redactSecrets(text.replace(/\s+/g, ' ').trim())
  return redacted.length > MAX_EXAMPLE_LENGTH
    ? `${redacted.slice(0, MAX_EXAMPLE_LENGTH - 1)}…`
    : redacted
}

/** Approvals and refusals a candidate would have removed. */
class Tally {
  approvals = 0
  denials = 0
  lastAt = 0
  readonly threads = new Set<string>()
  readonly examples: string[] = []

  add(item: PromptEvidence, example: string): void {
    if (item.verdict === 'denied') {
      this.denials++
      return
    }
    this.approvals++
    this.threads.add(item.threadId)
    if (item.at > this.lastAt) this.lastAt = item.at
    const text = exampleText(example)
    if (!this.examples.includes(text)) this.examples.push(text)
  }

  qualifies(): boolean {
    return this.approvals >= MIN_APPROVALS && this.threads.size >= MIN_THREADS
  }
}

function draft(
  kind: EnvironmentSuggestionKind,
  value: string,
  label: string,
  risk: string,
  tally: Tally,
  lowRisk: boolean,
): DraftSuggestion {
  const declined = tally.denials > 0
  return {
    kind,
    value,
    label,
    risk,
    approvals: tally.approvals,
    threads: tally.threads.size,
    lastAt: tally.lastAt,
    examples: tally.examples.slice(-MAX_EXAMPLES).reverse(),
    checked: lowRisk && !declined && tally.approvals >= PRECHECK_APPROVALS,
    declined,
  }
}

function tallyFor<K>(map: Map<K, Tally>, key: K): Tally {
  let tally = map.get(key)
  if (!tally) {
    tally = new Tally()
    map.set(key, tally)
  }
  return tally
}

/** The tier a recognised auto-approval shape lands in, or null for any other command. */
function autoApprovalShapeTier(
  command: string,
  context: SuggestionContext,
): AutoApprovalTier | null {
  const decision = assessAutoApproval(command, {
    workspaceRoot: context.workspaceRoot,
    level: 'remote-write',
    configuredRemotes: context.configuredRemotes,
  })
  return decision.action === 'auto-approve' ? decision.tier : null
}

/**
 * The lowest level above the current one whose covered prompts qualify. Least
 * privilege: never suggest pushes when commits alone clear the bar.
 */
function autoApprovalSuggestion(
  byTier: ReadonlyMap<AutoApprovalTier, PromptEvidence[]>,
  context: SuggestionContext,
): DraftSuggestion | null {
  const covered: PromptEvidence[] = []
  for (const level of AUTO_APPROVAL_LEVELS) {
    if (level === 'off') continue
    covered.push(...(byTier.get(level) ?? []))
    if (AUTO_APPROVAL_RANK[level] <= AUTO_APPROVAL_RANK[context.autoApprovalLevel]) continue
    const tally = new Tally()
    for (const item of covered) tally.add(item, item.command ?? '')
    if (!tally.qualifies()) continue
    return draft(
      'auto-approval-level',
      level,
      `Raise shell auto-approval to “${AUTO_APPROVAL_LEVEL_LABELS[level]}”`,
      autoApprovalRisk(level),
      tally,
      true,
    )
  }
  return null
}

/**
 * Whether the harm gate asks about `command` with today's trust and would allow
 * it with `extra` trusted too. Each list is tried alone: a command that needs a
 * host and a registry trusted at once is not suggested.
 */
function harmClearedBy(
  command: string,
  context: SuggestionContext,
  extra: { hosts?: readonly string[]; registries?: readonly string[] },
): boolean {
  const today: ShellHarmContext = {
    ...context.harm,
    trustedSshHosts: context.trustedSshHosts,
    trustedPackageRegistries: context.trustedPackageRegistries,
  }
  if (assessShellHarm(command, today).action !== 'prompt') return false
  const widened: ShellHarmContext = {
    ...today,
    trustedSshHosts: [...context.trustedSshHosts, ...(extra.hosts ?? [])],
    trustedPackageRegistries: [...context.trustedPackageRegistries, ...(extra.registries ?? [])],
  }
  return assessShellHarm(command, widened).action === 'allow'
}

/** The untrusted hosts whose trust alone would have let the harm gate allow `command`. */
function sshHostsFor(command: string, context: SuggestionContext): string[] {
  const trusted = new Set(context.trustedSshHosts)
  const candidates = sshDestinationHosts(command).filter((host) => !trusted.has(host))
  return candidates.length > 0 && harmClearedBy(command, context, { hosts: candidates })
    ? candidates
    : []
}

/** The untrusted registries whose trust alone would have let the harm gate allow `command`. */
function registriesFor(command: string, context: SuggestionContext): string[] {
  const trusted = new Set(context.trustedPackageRegistries)
  const candidates = commandPackageRegistries(command).filter((origin) => !trusted.has(origin))
  return candidates.length > 0 && harmClearedBy(command, context, { registries: candidates })
    ? candidates
    : []
}

export function buildEnvironmentSuggestions(
  evidence: readonly PromptEvidence[],
  context: SuggestionContext,
): DraftSuggestion[] {
  const byTier = new Map<AutoApprovalTier, PromptEvidence[]>()
  const commands = new Map<string, Tally>()
  const origins = new Map<string, Tally>()
  const hosts = new Map<string, Tally>()
  const registries = new Map<string, Tally>()
  const allowedOrigins = new Set(context.webAllowedOrigins)

  for (const item of evidence) {
    const command = item.command
    if (item.kind === 'web' && item.cause === 'web-origin') {
      const origin = context.normalizeOrigin(item.subject)
      if (origin && !allowedOrigins.has(origin)) tallyFor(origins, origin).add(item, origin)
      continue
    }
    if (item.kind !== 'shell' || command === undefined || item.cause === undefined) continue

    if (item.cause === 'shell-guarded-yolo-harm') {
      for (const host of sshHostsFor(command, context)) tallyFor(hosts, host).add(item, command)
      for (const origin of registriesFor(command, context)) {
        tallyFor(registries, origin).add(item, command)
      }
      continue
    }

    // A recognised shape has a narrower grant than its binary: raising the tier
    // allows `git push origin`, trusting `git` would allow every git command
    // outside the sandbox. So a shape never counts toward trusting its binary,
    // and counts toward a tier only where auto-approval can fire (a live sandbox).
    const tier = autoApprovalShapeTier(command, context)
    if (tier !== null) {
      if (
        context.sandboxActive &&
        AUTO_APPROVAL_CAUSES.has(item.cause) &&
        !autoApprovalLevelAllows(context.autoApprovalLevel, tier)
      ) {
        const list = byTier.get(tier) ?? []
        list.push(item)
        byTier.set(tier, list)
      }
      continue
    }

    if (!ESCALATION_CAUSES.has(item.cause)) continue
    const head = trustableCommandHead(command)
    if (head === null || context.trustedCommands.has(head)) continue
    const routed = resolveCommandRouting(
      command,
      context.workspaceRoot,
      new Set([...context.trustedCommands, head]),
    )
    if (routed.outcome === 'allow') tallyFor(commands, head).add(item, command)
  }

  const out: DraftSuggestion[] = []
  const level = autoApprovalSuggestion(byTier, context)
  if (level) out.push(level)
  for (const [origin, tally] of origins) {
    if (tally.qualifies())
      out.push(draft('web-origin', origin, `Allow ${origin}`, WEB_ORIGIN_RISK, tally, true))
  }
  for (const [head, tally] of commands) {
    if (tally.qualifies())
      out.push(
        draft(
          'trusted-command',
          head,
          `Trust ${head} to run outside the sandbox`,
          TRUSTED_COMMAND_RISK,
          tally,
          false,
        ),
      )
  }
  for (const [host, tally] of hosts) {
    if (tally.qualifies())
      out.push(
        draft('trusted-ssh-host', host, `Trust SSH host ${host}`, SSH_HOST_RISK, tally, false),
      )
  }
  for (const [origin, tally] of registries) {
    if (tally.qualifies())
      out.push(
        draft(
          'trusted-package-registry',
          origin,
          `Trust package registry ${origin}`,
          REGISTRY_RISK,
          tally,
          false,
        ),
      )
  }
  return out
}
