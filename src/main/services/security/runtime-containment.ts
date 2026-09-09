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
 * Session-only and never read from settings, so nothing persisted can make a
 * desktop session believe it is contained.
 */

/** Parse a host-written attestation; null when it is not one. */
export function parseContainerRuntimeAttestation(text: string): ContainerRuntimeAttestation | null {
  return safeJsonParse(text, decodeWithSchema(containerRuntimeAttestationSchema))
}

/**
 * Why an attestation does not describe a contained runtime, or null when it
 * does. The bar is the one `execution-runtime-security.md` R4 sets: unprivileged
 * user, read-only base, no ambient capabilities, no privilege escalation, no
 * unmediated network, and no host filesystem beyond the run directory.
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
  return null
}

let declared: ContainerRuntimeAttestation | null = null

/**
 * Declare that this process runs inside the attested container. Refuses an
 * attestation that falls short of the bar rather than downgrading it silently:
 * a worker that cannot declare containment simply runs with the desktop rules,
 * which prompt (and, unattended, defer) — safe, just less productive.
 */
export function declareContainerRuntime(attestation: ContainerRuntimeAttestation): void {
  const shortfall = containerAttestationShortfall(attestation)
  if (shortfall !== null) {
    throw new Error(`Refusing to declare container containment: ${shortfall}`)
  }
  declared = attestation
}

export function declaredContainerRuntime(): ContainerRuntimeAttestation | null {
  return declared
}

export function isContainerRuntime(): boolean {
  return declared !== null
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
