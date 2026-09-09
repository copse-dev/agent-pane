import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { sensitiveTargetReason } from '../security/read-outside-project.ts'
import { grantThreadReadRoot, type ThreadReadRoot } from '../security/thread-read-roots.ts'
import type { SkillMetadata, SkillSource } from '@shared/types/skills.ts'

/**
 * Turn an invoked skill into the read-only roots its thread's sandboxed shell
 * may open (see `thread-read-roots.ts` for who consumes them).
 *
 * The skill directory itself is always a candidate. On top of it, the `paths`
 * frontmatter list lets a skill name extra read-only entries *relative to its
 * own directory*. The list is validated here, not trusted:
 *
 * - relative only — an absolute path, `~`, or a `$VAR` is rejected, so a
 *   workspace skill cannot declare `/etc` or `~/.aws`;
 * - no `..` segment, so an entry cannot climb out of the skill directory by
 *   spelling;
 * - never a credential file or directory (`sensitiveTargetReason`, the same
 *   judgement the read-outside-project grant applies), and never the home
 *   directory, the filesystem root, or an ancestor of home;
 * - an entry that is a symlink out of the skill directory is honoured only for
 *   a trusted source (`user`, `bundled`): the user installed that skill and
 *   made the link. A `project` / `plugin` skill is attacker-controllable, so a
 *   symlink escape from it is refused — the workspace already owns its own
 *   files, and a link is the only way such a skill could widen reads.
 *
 * The result is applied per thread, so a skill invoked in one thread never
 * widens another's sandbox.
 */
export interface SkillReadRootResolution {
  /** Roots that were granted (or would be), in the spelling the skill uses. */
  granted: ThreadReadRoot[]
  /** `entry: reason` for every declared path that was refused. */
  rejected: string[]
}

function isTrustedSource(source: SkillSource): boolean {
  return source === 'user' || source === 'bundled'
}

/** Why a `paths` entry is unacceptable by spelling alone, or null when it may be resolved. */
export function declaredSkillPathProblem(entry: string): string | null {
  const trimmed = entry.trim()
  if (!trimmed) return 'empty entry'
  if (isAbsolute(trimmed) || trimmed.startsWith('~') || trimmed.startsWith('$')) {
    return 'must be relative to the skill directory'
  }
  const segments = trimmed.split(/[/\\]/)
  if (segments.includes('..')) return 'must not contain ".."'
  return null
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Targets so broad that granting them is granting the machine. */
function breadthProblem(canonical: string, home: string): string | null {
  if (canonical === sep) return 'is the whole filesystem'
  if (canonical === home) return 'is the whole home directory'
  if (home.startsWith(canonical + sep)) return 'is a parent of the home directory'
  return null
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fsp.realpath(path)
  } catch {
    return null
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fsp.stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function resolveSkillReadRoots(
  skill: Pick<SkillMetadata, 'name' | 'skillRoot' | 'source' | 'paths'>,
  options: { homeDir?: string } = {},
): Promise<SkillReadRootResolution> {
  const home = options.homeDir ?? homedir()
  const granted: ThreadReadRoot[] = []
  const rejected: string[] = []

  const skillRoot = resolve(skill.skillRoot)
  const canonicalRoot = await realpathOrNull(skillRoot)
  if (canonicalRoot === null) {
    rejected.push(`${skillRoot}: skill directory is missing`)
    return { granted, rejected }
  }
  // A skill that lives inside a credential store (or *is* home) grants nothing:
  // its directory would otherwise carry the whole store into the sandbox.
  const rootProblem =
    sensitiveTargetReason(skillRoot, canonicalRoot) ?? breadthProblem(canonicalRoot, home)
  if (rootProblem) {
    rejected.push(`${skillRoot}: ${rootProblem}`)
    return { granted, rejected }
  }
  granted.push({
    path: skillRoot,
    canonical: canonicalRoot,
    isDirectory: true,
    label: `skill "${skill.name}" directory`,
  })

  const trusted = isTrustedSource(skill.source)
  for (const entry of skill.paths) {
    const problem = declaredSkillPathProblem(entry)
    if (problem) {
      rejected.push(`${entry}: ${problem}`)
      continue
    }
    const declared = resolve(skillRoot, entry.trim())
    // Belt and braces: `..`-free relative entries cannot leave the root by
    // spelling, but a normalised path is what the checks below reason about.
    if (!isInside(declared, skillRoot)) {
      rejected.push(`${entry}: resolves outside the skill directory`)
      continue
    }
    // By name first — a credential-looking entry is refused whether or not
    // it exists, so the reason never depends on what is on disk.
    const declaredSensitive = sensitiveTargetReason(entry, declared)
    if (declaredSensitive) {
      rejected.push(`${entry}: ${declaredSensitive}`)
      continue
    }
    const canonical = await realpathOrNull(declared)
    if (canonical === null) {
      rejected.push(`${entry}: does not exist`)
      continue
    }
    // And again where the symlink actually lands.
    const sensitive = sensitiveTargetReason(entry, canonical)
    if (sensitive) {
      rejected.push(`${entry}: ${sensitive}`)
      continue
    }
    const breadth = breadthProblem(canonical, home)
    if (breadth) {
      rejected.push(`${entry}: ${breadth}`)
      continue
    }
    if (!isInside(canonical, canonicalRoot)) {
      if (!trusted) {
        rejected.push(`${entry}: symlink leaves the skill directory (untrusted source)`)
        continue
      }
      // A trusted skill's symlink is a deliberate install choice; the credential
      // and breadth checks above still bound where it may point.
    } else if (canonical !== canonicalRoot) {
      // Already covered by the skill directory grant; recording it again would
      // only grow the seatbelt profile.
      continue
    }
    granted.push({
      path: declared,
      canonical,
      isDirectory: await isDirectory(canonical),
      label: `skill "${skill.name}" paths entry "${entry}"`,
    })
  }

  return { granted, rejected }
}

/**
 * Resolve and record an invoked skill's read roots for `threadId`. Rejections
 * are logged (the skill author's declaration was wrong, not the user's action)
 * and returned so the prompt can tell the model what is and is not readable.
 */
export async function grantInvokedSkillReadRoots(
  threadId: string,
  skill: Pick<SkillMetadata, 'name' | 'skillRoot' | 'source' | 'paths'>,
): Promise<SkillReadRootResolution> {
  const resolution = await resolveSkillReadRoots(skill)
  for (const root of resolution.granted) grantThreadReadRoot(threadId, root)
  for (const rejection of resolution.rejected) {
    console.warn(`[skills] "${skill.name}": ignoring declared path — ${rejection}`)
  }
  return resolution
}
