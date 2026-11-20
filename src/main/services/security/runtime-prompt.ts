/**
 * Approval-prompt copy for where a command runs and what approving changes
 * (`docs/plans/execution-runtime-security.md`, R1-9).
 *
 * The lines are derived from the same capability snapshot the execution audit
 * records, so a prompt cannot promise a property the runtime does not report.
 * Pure: no Electron, no settings.
 */
import {
  deriveRuntimeCapabilities,
  type ExecutionRuntimeCapabilities,
  type LocalContainment,
  type RuntimeProfile,
} from '@shared/threads/execution-runtime.ts'

type Labels<K extends keyof ExecutionRuntimeCapabilities> = Record<
  Exclude<ExecutionRuntimeCapabilities[K], undefined> & string,
  string
>

const FILESYSTEM: Labels<'filesystem'> = {
  workspace: 'this project only',
  host: 'everything your account can open on this computer',
  'remote-account': 'everything the remote account can open',
}

const NETWORK: Labels<'network'> = {
  none: 'none',
  'global-allowlist': 'only hosts the sandbox already allows',
  'per-execution-broker': 'only hosts approved for this command',
  unrestricted: 'any host',
}

const ISOLATION: Labels<'processIsolation'> = {
  none: 'none',
  'os-sandbox': 'the project sandbox',
  container: 'a container',
  vm: 'a virtual machine',
  'provider-managed': "the provider's sandbox",
}

const SECRETS: Labels<'secrets'> = {
  'raw-env': 'your sign-in tokens in its environment',
  'scoped-injection': 'only the tokens named for it',
  brokered: 'none: Copse adds them for approved requests',
}

/**
 * The properties that differ between two runtime profiles, one bullet each, in
 * the order a person weighs them. Empty when nothing changes.
 */
export function runtimeChangeLines(from: RuntimeProfile, to: RuntimeProfile): string[] {
  const before = deriveRuntimeCapabilities(from)
  const after = deriveRuntimeCapabilities(to)
  const lines: string[] = []
  if (before.filesystem !== after.filesystem) {
    lines.push(`Files: ${FILESYSTEM[before.filesystem]} → ${FILESYSTEM[after.filesystem]}`)
  }
  if (before.network !== after.network) {
    lines.push(`Network: ${NETWORK[before.network]} → ${NETWORK[after.network]}`)
  }
  if (before.processIsolation !== after.processIsolation) {
    lines.push(
      `Isolation: ${ISOLATION[before.processIsolation]} → ${ISOLATION[after.processIsolation]}`,
    )
  }
  if (before.secrets !== after.secrets) {
    lines.push(`Credentials: ${SECRETS[before.secrets]} → ${SECRETS[after.secrets]}`)
  }
  return lines
}

const CONTAINED: RuntimeProfile = { kind: 'local', containment: 'contained' }
const HOST: RuntimeProfile = { kind: 'local', containment: 'host' }

/**
 * The section every sandbox-escape prompt shows: what running this command
 * outside the project sandbox changes, property by property.
 */
export function sandboxEscapeChangeSection(): string {
  return `Approving changes how it runs:\n${runtimeChangeLines(CONTAINED, HOST)
    .map((line) => `• ${line}`)
    .join('\n')}`
}

/** Where a prompted command runs, as its approval prompt describes it. */
export type PromptRuntime =
  | { readonly kind: 'local'; readonly containment: LocalContainment }
  | {
      readonly kind: 'ssh'
      /** The host as the user knows it: its label and `user@address`. */
      readonly name: string
      /** Whether Copse forwards the user's SSH agent to this host (its `forwardAgent`). */
      readonly forwardsAgent: boolean
    }

/** The configured SSH host a prompt describes; absent when no host record matches. */
export interface SshPromptHost {
  readonly label: string
  /** `user@hostname` as the host settings show it. */
  readonly address: string
  readonly forwardAgent: boolean
}

/**
 * Describe an SSH workspace host for a prompt: by its label and address, so a
 * person recognises the machine, falling back to the host id.
 */
export function sshPromptRuntime(hostId: string, host: SshPromptHost | undefined): PromptRuntime {
  if (!host) return { kind: 'ssh', name: hostId, forwardsAgent: false }
  const label = host.label.trim()
  return {
    kind: 'ssh',
    name: label && label !== host.address ? `${label} (${host.address})` : host.address,
    forwardsAgent: host.forwardAgent,
  }
}

/**
 * The opening line of an ordinary shell prompt: where the command runs. An SSH
 * command names its host, because Copse applies no sandbox there whatever this
 * computer's sandbox state. It also names the host's network and, when Copse
 * forwards the user's SSH agent there, the keys in that agent: both are reach
 * the approval hands over beyond the remote account's own files.
 */
export function runtimeLeadLine(runtime: PromptRuntime, unsandboxedWarning: string): string {
  if (runtime.kind === 'ssh') {
    const lead =
      `This runs on ${runtime.name} over SSH, as that account. Copse adds no sandbox there: ` +
      'it can read and change anything that account can, and reach any network that host can.'
    return runtime.forwardsAgent
      ? `${lead} It can also use the SSH keys in your local agent, which Copse forwards to this host.`
      : lead
  }
  return runtime.containment === 'contained'
    ? 'This runs inside the project sandbox. It can still change or delete project files.'
    : `The project sandbox is unavailable for this command. ${unsandboxedWarning}`
}
