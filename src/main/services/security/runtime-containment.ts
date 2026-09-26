import { readdirSync, readFileSync } from 'node:fs'
import { containerRuntimeAttestationSchema } from '@shared/container-run-schema.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type {
  ContainerRuntimeAttestation,
  RuntimeContainmentTier,
} from '@shared/types/unattended-run.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'

/**
 * What confines *this process* (`docs/plans/thread-in-container.md`).
 *
 * The desktop app runs on the user's machine and confines each command with the
 * project sandbox (ASRT seatbelt / bubblewrap) when it can. A container worker
 * is the other way round: the whole process — loop, tools, everything — already
 * sits inside a disposable guest the host hardened before starting it. The
 * permission gate needs to know which of the two it is in, because the same
 * command has a different blast radius in each.
 *
 * A declaration, not a probe. A guest cannot verify its own boundary from the
 * inside, so the only honest source is the host that started it: it writes an
 * attestation of the flags it used, and the worker declares from that record.
 * What the guest *can* see of itself — its uid, its capability sets, whether
 * no-new-privileges is on, which network interfaces exist, whether its root is
 * mounted read-only — it checks against the record before declaring, so a flag
 * an engine silently dropped refuses the declaration instead of being believed.
 * Session-only and never read from settings, so nothing persisted can make a
 * desktop session believe it is contained.
 */

/** Parse a host-written attestation; null when it is not one. */
export function parseContainerRuntimeAttestation(text: string): ContainerRuntimeAttestation | null {
  return safeJsonParse(text, decodeWithSchema(containerRuntimeAttestationSchema))
}

type AttestedEngine = NonNullable<ContainerRuntimeAttestation['engine']>

/**
 * What each engine must attest beyond the common bar. The two isolate the
 * guest differently, so the properties that stand for "the boundary" differ:
 *
 * - Docker shares the host's kernel. Its default seccomp and AppArmor profiles
 *   are the syscall boundary to that kernel, so they are required, and the
 *   process limit is a cgroup over the container.
 * - Apple container gives each container a VM with its own kernel. There is
 *   no seccomp or AppArmor to claim, and a claim of either would be false, so
 *   the bar is `none` there; the process limit is `RLIMIT_NPROC` on the worker
 *   uid, which is the only uid running in that guest kernel.
 */
const ENGINE_BAR: Record<
  AttestedEngine,
  {
    isolation: NonNullable<ContainerRuntimeAttestation['isolation']>
    securityProfiles: NonNullable<ContainerRuntimeAttestation['securityProfiles']>
    processLimit: NonNullable<ContainerRuntimeAttestation['processLimit']>
  }
> = {
  docker: { isolation: 'shared-kernel', securityProfiles: 'default', processLimit: 'cgroup-pids' },
  apple: { isolation: 'vm', securityProfiles: 'none', processLimit: 'rlimit-nproc' },
}

/**
 * Why an attestation does not describe a contained runtime, or null when it
 * does. The bar is the one `execution-runtime-security.md` R4 sets: unprivileged
 * user, read-only base, no ambient capabilities, no privilege escalation, no
 * unmediated network, and no host filesystem beyond the run directory — plus
 * what the engine's own isolation needs ({@link ENGINE_BAR}). A field an engine
 * cannot vouch for is a shortfall, never a default: Apple container must say
 * every one of its fields; only Docker, the engine every record before this
 * one came from, may leave `engine`, `isolation` and `processLimit` unsaid.
 */
export function containerAttestationShortfall(
  attestation: ContainerRuntimeAttestation,
): string | null {
  if (attestation.user === 0) return 'worker runs as root'
  if (!attestation.readOnlyRootfs) return 'root filesystem is writable'
  if (!attestation.capDropAll) return 'ambient capabilities were not dropped'
  if (!attestation.noNewPrivileges) return 'no-new-privileges is not set'
  if (attestation.network === 'none' && attestation.egressAllowlist.length > 0) {
    return 'egress allowlist declared without a broker'
  }
  const foreignMount = attestation.hostMounts.find((mount) => !/^\/run\/copse(?:\/|$)/.test(mount))
  if (foreignMount !== undefined) return `host path mounted into the guest: ${foreignMount}`

  const engine = attestation.engine ?? 'docker'
  const bar = ENGINE_BAR[engine]
  const legacyDocker = engine === 'docker'
  const isolation = attestation.isolation ?? (legacyDocker ? bar.isolation : undefined)
  if (isolation !== bar.isolation) {
    return `${engine} cannot provide ${isolation ?? 'unstated'} isolation (expected ${bar.isolation})`
  }
  if (attestation.securityProfiles !== bar.securityProfiles) {
    return engine === 'docker'
      ? `a shared-kernel container needs its default seccomp and AppArmor profiles (attested ${attestation.securityProfiles ?? 'nothing'})`
      : `a VM guest has no seccomp or AppArmor profiles to attest (attested ${attestation.securityProfiles ?? 'nothing'})`
  }
  const processLimit = attestation.processLimit ?? (legacyDocker ? bar.processLimit : undefined)
  if (processLimit !== bar.processLimit) {
    return `${engine} enforces the process limit as ${bar.processLimit}, not ${processLimit ?? 'unstated'}`
  }
  return null
}

/**
 * What the guest can see of its own confinement. Read once, before declaring;
 * {@link observeGuestContainment} fills it from `/proc` and `/sys`.
 */
export interface GuestContainmentObservation {
  uid: number
  /** CapInh, CapPrm, CapEff, CapBnd, CapAmb from `/proc/self/status`, as read. */
  capabilitySets: Record<'inheritable' | 'permitted' | 'effective' | 'bounding' | 'ambient', bigint>
  noNewPrivileges: boolean
  /** Network devices that are up (`IFF_UP`), by name; see {@link upNetworkInterfaces}. */
  upNetworkInterfaces: string[]
  /** The options of the mount at `/`, from `/proc/self/mounts`; empty when not found. */
  rootMountOptions: string[]
}

/** The status line `Name:\tvalue` for `name`, or null when absent. */
function statusField(status: string, name: string): string | null {
  for (const line of status.split('\n')) {
    const separator = line.indexOf(':')
    if (separator !== -1 && line.slice(0, separator) === name) {
      return line.slice(separator + 1).trim()
    }
  }
  return null
}

export interface GuestContainmentSources {
  status: string
  mounts: string
  upNetworkInterfaces: string[]
  uid: number
}

/**
 * Parse the guest's own view of itself. Returns a reason string when a source
 * is unreadable or malformed: a guest that cannot see its confinement cannot
 * vouch for it, and the declaration is refused rather than guessed.
 */
export function parseGuestContainment(
  sources: GuestContainmentSources,
): GuestContainmentObservation | string {
  const capability = (field: string): bigint | null => {
    const value = statusField(sources.status, field)
    return value !== null && /^[0-9a-f]+$/i.test(value) ? BigInt(`0x${value}`) : null
  }
  const inheritable = capability('CapInh')
  const permitted = capability('CapPrm')
  const effective = capability('CapEff')
  const bounding = capability('CapBnd')
  const ambient = capability('CapAmb')
  if (
    inheritable === null ||
    permitted === null ||
    effective === null ||
    bounding === null ||
    ambient === null
  ) {
    return 'cannot read the capability sets'
  }
  const noNewPrivileges = statusField(sources.status, 'NoNewPrivs')
  if (noNewPrivileges === null) return 'cannot read NoNewPrivs'
  let rootMountOptions: string[] = []
  for (const line of sources.mounts.split('\n')) {
    const [, mountPoint, , options] = line.split(' ')
    // The last mount at `/` is the one in effect.
    if (mountPoint === '/' && options !== undefined) rootMountOptions = options.split(',')
  }
  return {
    uid: sources.uid,
    capabilitySets: { inheritable, permitted, effective, bounding, ambient },
    noNewPrivileges: noNewPrivileges === '1',
    upNetworkInterfaces: [...sources.upNetworkInterfaces].sort(),
    rootMountOptions,
  }
}

/** One entry of `/sys/class/net`, with its `flags` file as read (null when unreadable). */
export interface NetClassEntry {
  name: string
  isFile: boolean
  flags: string | null
}

const IFF_UP = 0x1

/**
 * The network devices that are up. Existing is not the question: Docker
 * Desktop's kernel gives every namespace, `--network none` included, the
 * tunnel drivers' fallback devices (`erspan0`, `gre0`, `sit0`, `tunl0`, …),
 * all down and with no route, and a guest with no capabilities cannot bring
 * one up. A regular file there is a control knob, not a device (the bonding
 * driver's `bonding_masters`). A device whose flags cannot be read counts as
 * up, so an unreadable `/sys` refuses the declaration rather than passing it.
 */
export function upNetworkInterfaces(entries: readonly NetClassEntry[]): string[] {
  return entries
    .filter((entry) => !entry.isFile)
    .filter((entry) => {
      const flags = entry.flags === null ? Number.NaN : Number.parseInt(entry.flags.trim(), 16)
      return Number.isNaN(flags) || (flags & IFF_UP) !== 0
    })
    .map((entry) => entry.name)
}

function readNetClass(): NetClassEntry[] {
  return readdirSync('/sys/class/net', { withFileTypes: true }).map((entry) => {
    let flags: string | null = null
    try {
      flags = readFileSync(`/sys/class/net/${entry.name}/flags`, 'utf8')
    } catch {
      // Left null: counted as up.
    }
    return { name: entry.name, isFile: entry.isFile(), flags }
  })
}

/** Read this process's view of its confinement from `/proc` and `/sys`. */
export function observeGuestContainment(): GuestContainmentObservation | string {
  try {
    return parseGuestContainment({
      status: readFileSync('/proc/self/status', 'utf8'),
      mounts: readFileSync('/proc/self/mounts', 'utf8'),
      upNetworkInterfaces: upNetworkInterfaces(readNetClass()),
      uid: process.getuid?.() ?? -1,
    })
  } catch (error) {
    return `cannot observe the guest: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Why what the guest sees of itself contradicts the attestation, or null when
 * it agrees. Only the properties a process can observe from the inside are
 * checked; the rest (the process limit, the engine's isolation) stay the
 * host's word.
 */
export function guestContainmentShortfall(
  attestation: ContainerRuntimeAttestation,
  observed: GuestContainmentObservation,
): string | null {
  if (observed.uid === 0) return 'the guest runs as root'
  if (observed.uid !== attestation.user) {
    return `the guest runs as uid ${String(observed.uid)}, not the attested ${String(attestation.user)}`
  }
  if (attestation.capDropAll) {
    const held = Object.entries(observed.capabilitySets).find(([, value]) => value !== 0n)
    if (held !== undefined) return `the guest still holds ${held[0]} capabilities`
  }
  if (attestation.noNewPrivileges && !observed.noNewPrivileges) {
    return 'no-new-privileges is off in the guest'
  }
  if (attestation.readOnlyRootfs && !observed.rootMountOptions.includes('ro')) {
    return 'the guest root filesystem is not mounted read-only'
  }
  // Both network modes mean no device up but loopback: brokered egress
  // crosses the container's stdio, never a network device.
  const device = observed.upNetworkInterfaces.find((name) => name !== 'lo')
  if (device !== undefined) return `the guest has a network interface up: ${device}`
  return null
}

let declared: ContainerRuntimeAttestation | null = null

/**
 * Declare that this process runs inside the attested container. Refuses an
 * attestation that falls short of the bar, or one the guest's own view of
 * itself contradicts, rather than downgrading it silently: a worker that cannot
 * declare containment simply runs with the desktop rules, which prompt (and,
 * unattended, defer) — safe, just less productive.
 */
export function declareContainerRuntime(
  attestation: ContainerRuntimeAttestation,
  observed: GuestContainmentObservation | string,
): void {
  const shortfall =
    containerAttestationShortfall(attestation) ??
    (typeof observed === 'string' ? observed : guestContainmentShortfall(attestation, observed))
  if (shortfall !== null) {
    throw new Error(`Refusing to declare container containment: ${shortfall}`)
  }
  declared = attestation
}

/** The containment tier of the runtime this process executes commands in. */
export function runtimeContainmentTier(): RuntimeContainmentTier {
  if (declared !== null) return 'container'
  return isProjectSandboxEnabled() ? 'project-sandbox' : 'unsandboxed'
}

/** Test seam: forget any declaration so one spec cannot contain the next. */
export function clearRuntimeContainmentForTests(): void {
  declared = null
}
