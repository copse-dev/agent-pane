import { AsyncLocalStorage } from 'node:async_hooks'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  discoverCursorPluginRoots,
  readCursorPluginName,
  resolvePluginSkillsDir,
} from './cursor-plugins.ts'
import {
  BUNDLED_CURSOR_SKILLS_SETTING,
  isBundledSkillPluginEnabled,
  listBundledCursorPluginRoots,
} from './bundled-cursor-skills.ts'
import { getBuiltinSkillsRoot } from './builtin-skills.ts'
import { pathExists, walkForContainerRoots, walkForFiles } from '../discovery/container-scan.ts'
import { getSetting } from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import {
  folderNameMatchesSkill,
  parseSkillFrontmatter,
  splitSkillMarkdown,
  toSkillMetadata,
} from './parse-skill-frontmatter.ts'
import type {
  SkillMetadata,
  SkillReadResult,
  SkillSource,
  SkillSummary,
} from '@shared/types/skills.ts'
import { READ_FILE_LIMITS_CEILING } from '@copse/agent/read-file-limits.ts'
import { extractExternalLinkHosts } from '@shared/skills/extract-skill-links.ts'
import { extractSkillFileReferences } from '@shared/skills/extract-skill-references.mts'
import { notifyRefreshContextEstimate } from '../context-estimate-notify.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { getPluginService } from '../plugins/plugin-service.ts'

/** Max bytes read from a skill file (auto-approved, outside workspace). */
export const SKILL_READ_MAX_BYTES = READ_FILE_LIMITS_CEILING.maxChars * 4

/**
 * Container directories a skills tree can live under, at both scopes:
 * `~/<container>/skills/<name>/SKILL.md` (user) and
 * `<workspace>/<container>/skills/<name>/SKILL.md` (project).
 *
 * Precedence within a scope follows this order, and first-writer-wins in
 * {@link loadSkillFromFile} makes it matter only for a name installed twice:
 *
 * 1. `.cursor` — the Cursor layout Copse has always read.
 * 2. `.agents` — the tool-neutral Agent Skills convention.
 * 3. `.claude` — Claude Code's layout.
 * 4. `.codex` — Codex CLI's layout (`~/.codex/skills`). Added last so a
 *    skill the user keeps in one of the earlier trees is unaffected by a
 *    Codex-installed copy of the same name; a Codex-only skill is found either
 *    way. Before this entry a skill invoked from a Codex-backed thread could
 *    not be discovered at all (reconcile-worktrees post-mortem, 2026-09-09).
 *
 * Across scopes, {@link collectDiscoveryTargets} orders user roots before project
 * roots, so a user-installed skill always beats a same-named workspace one.
 */
export const SKILL_CONTAINER_DIRS: readonly string[] = ['.cursor', '.agents', '.claude', '.codex']
const SKILL_CONTAINER_DIR_SET: ReadonlySet<string> = new Set(SKILL_CONTAINER_DIRS)

/**
 * A skill discovery found — a `SKILL.md` under a discovered container — but
 * could not turn into a usable {@link SkillMetadata}: bad frontmatter, or a
 * frontmatter `name` that does not match its folder. Tracked separately from
 * silently-dropped discovery so {@link unknownSkillError} can tell the model
 * "this name is a broken registry entry" instead of "no such skill", which
 * would otherwise invite it to keep guessing names that were never going to
 * exist (issue #1438).
 */
export interface SkillLoadFailure {
  /** Names a caller might reasonably try — the frontmatter name and/or the folder name. */
  readonly attemptedNames: readonly string[]
  readonly skillPath: string
  readonly reason: string
}

let cachedSkills: SkillMetadata[] = []
let cachedSkillLoadFailures: SkillLoadFailure[] = []
let cachedSwitchedOffPlugins: string[] = []
let refreshPromise: Promise<void> | null = null
interface SkillRegistrySnapshot {
  readonly skills: readonly SkillMetadata[]
  readonly failures: readonly SkillLoadFailure[]
  /** Bundled plugins left out because their own switch is off. */
  readonly switchedOffPlugins: readonly string[]
}
const scopedSkills = new AsyncLocalStorage<SkillRegistrySnapshot>()

function activeSkills(): readonly SkillMetadata[] {
  return scopedSkills.getStore()?.skills ?? cachedSkills
}

function activeSkillLoadFailures(): readonly SkillLoadFailure[] {
  return scopedSkills.getStore()?.failures ?? cachedSkillLoadFailures
}

function activeSwitchedOffPlugins(): readonly string[] {
  return scopedSkills.getStore()?.switchedOffPlugins ?? cachedSwitchedOffPlugins
}

function skillsEnabled(): boolean {
  return getSetting<boolean>('skillsEnabled', true)
}

/**
 * User-scope skills trees, in precedence order (see {@link SKILL_CONTAINER_DIRS}).
 * `home` is a parameter so tests can assert the list without depending on the
 * developer's real home directory.
 */
export function userSkillRoots(home: string = userSkillsHome()): string[] {
  return SKILL_CONTAINER_DIRS.map((dir) => join(home, dir, 'skills'))
}

let userSkillsHomeOverride: string | null = null

function userSkillsHome(): string {
  return userSkillsHomeOverride ?? homedir()
}

/**
 * Test helper — point user-scope discovery at a directory other than the real
 * home, so a developer's own `~/.codex/skills` (which legitimately overrides a
 * same-named built-in) cannot leak into a suite's expectations.
 */
export function setUserSkillsHomeForTest(home: string | null): void {
  userSkillsHomeOverride = home
}

/** Stable sort of `<dir>/<container>/skills` roots by {@link SKILL_CONTAINER_DIRS} order. */
function sortByContainerPrecedence(skillRoots: readonly string[]): string[] {
  const rank = (root: string): number => {
    const index = SKILL_CONTAINER_DIRS.indexOf(basename(dirname(root)))
    return index === -1 ? SKILL_CONTAINER_DIRS.length : index
  }
  return skillRoots
    .map((root, order) => ({ root, order, rank: rank(root) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ root }) => root)
}

/** Resolve bundle-relative references against the skill root; return the ones that don't exist. */
async function findMissingReferences(
  skillRoot: string,
  references: readonly string[],
): Promise<string[]> {
  const missing: string[] = []
  for (const reference of references) {
    const target = resolve(skillRoot, reference)
    const rel = relative(skillRoot, target)
    // A reference that resolves outside the bundle isn't this check's concern
    // (the sandboxing in `readSkill` handles path escapes at read time).
    if (rel.startsWith('..')) continue
    if (!(await pathExists(target))) missing.push(reference)
  }
  return missing
}

async function loadSkillFromFile(
  skillPath: string,
  source: SkillSource,
  skills: Map<string, SkillMetadata>,
  failures: SkillLoadFailure[],
  plugin?: string,
): Promise<void> {
  let raw: string
  try {
    raw = await fsp.readFile(skillPath, 'utf-8')
  } catch {
    return
  }

  const folderName = basename(dirname(skillPath))

  const split = splitSkillMarkdown(raw)
  if (!split) {
    console.warn(`[skills] Skipping ${skillPath}: missing frontmatter`)
    failures.push({
      attemptedNames: [folderName],
      skillPath,
      reason: 'SKILL.md has no YAML frontmatter block (a leading `---`-delimited header)',
    })
    return
  }

  const parsed = parseSkillFrontmatter(split.frontmatter)
  if (!parsed) {
    console.warn(`[skills] Skipping ${skillPath}: invalid frontmatter`)
    failures.push({
      attemptedNames: [folderName],
      skillPath,
      reason: 'frontmatter is missing the required `name` or `description` field',
    })
    return
  }

  if (!folderNameMatchesSkill(skillPath, parsed.name)) {
    console.warn(
      `[skills] Skipping ${skillPath}: name "${parsed.name}" does not match folder "${folderName}"`,
    )
    failures.push({
      attemptedNames: [...new Set([parsed.name, folderName])],
      skillPath,
      reason: `frontmatter name "${parsed.name}" does not match its folder "${folderName}"`,
    })
    return
  }

  const existing = skills.get(parsed.name)
  if (existing) {
    console.warn(
      `[skills] Duplicate skill "${parsed.name}" — keeping first from ${existing.skillPath}`,
    )
    return
  }

  // Scan the whole file (description + body) so a link hidden in either surface
  // is still flagged up front before the skill runs.
  const externalLinks = extractExternalLinkHosts(raw)

  // Reference integrity: a SKILL.md that points at `references/x.md` (or
  // scripts/, assets/) which isn't actually in the bundle fails read_skill
  // mid-run with no warning beforehand. Flag it once, here, at discovery time
  // (issue #1438) — logged now, and surfaced to the model in the tool result
  // when the skill is read (see `readSkill`).
  const skillRoot = dirname(skillPath)
  const missingReferences = await findMissingReferences(skillRoot, extractSkillFileReferences(raw))
  if (missingReferences.length > 0) {
    console.warn(
      `[skills] "${parsed.name}" references missing file(s) in its bundle: ` +
        `${missingReferences.join(', ')} (${skillRoot})`,
    )
  }

  skills.set(
    parsed.name,
    toSkillMetadata(parsed, skillPath, source, externalLinks, missingReferences, plugin),
  )
}

interface SkillDiscoveryTarget {
  readonly kind: 'root' | 'file'
  readonly path: string
  readonly source: SkillSource
  /** Plugin that ships the skills under this target, when there is one. */
  readonly plugin?: string
}

async function collectDiscoveryTargets(): Promise<{
  targets: SkillDiscoveryTarget[]
  switchedOffPlugins: string[]
}> {
  const targets: SkillDiscoveryTarget[] = []
  const switchedOffPlugins: string[] = []

  for (const root of userSkillRoots()) {
    if (await pathExists(root)) targets.push({ kind: 'root', path: root, source: 'user' })
  }

  if (getSetting<boolean>(BUNDLED_CURSOR_SKILLS_SETTING, true)) {
    for (const pluginRoot of await listBundledCursorPluginRoots()) {
      const skillsDir = await resolvePluginSkillsDir(pluginRoot)
      if (!skillsDir) continue
      const plugin = await readCursorPluginName(pluginRoot)
      if (!isBundledSkillPluginEnabled(plugin)) {
        switchedOffPlugins.push(plugin)
        continue
      }
      targets.push({ kind: 'root', path: skillsDir, source: 'bundled', plugin })
    }
  }

  const workspace = getWorkspaceRoot()
  if (workspace) {
    const projectRoots = new Set<string>()
    await walkForContainerRoots(
      workspace,
      { containerDirs: SKILL_CONTAINER_DIR_SET, leafName: 'skills' },
      projectRoots,
    )
    // The walk yields roots in directory order (`.claude` before `.cursor`);
    // sort them so first-writer-wins follows the documented container
    // precedence, with the walk order as the tiebreak between subdirectories.
    for (const root of sortByContainerPrecedence([...projectRoots])) {
      targets.push({ kind: 'root', path: root, source: 'project' })
    }
  }

  // Agent Plugins §7.1 permits only immediate-child skills. Discovery records
  // the exact contained files, so add those directly instead of feeding the
  // portable `skills/` directory to Copse's recursive legacy scanner.
  for (const plugin of getPluginService().enabledUserPlugins()) {
    for (const skillPath of plugin.skillFiles) {
      targets.push({
        kind: 'file',
        path: skillPath,
        source: 'plugin',
        plugin: plugin.manifest.name,
      })
    }
  }

  for (const pluginRoot of await discoverCursorPluginRoots()) {
    const skillsDir = await resolvePluginSkillsDir(pluginRoot)
    if (skillsDir) {
      const plugin = await readCursorPluginName(pluginRoot)
      targets.push({ kind: 'root', path: skillsDir, source: 'plugin', plugin })
    }
  }

  const pluginPaths = getSetting<string[]>('skillPluginPaths', [])
  for (const pluginPath of pluginPaths) {
    const resolved = resolve(pluginPath)
    if (!(await pathExists(resolved))) continue
    const manifest = join(resolved, '.cursor-plugin', 'plugin.json')
    if (await pathExists(manifest)) {
      const skillsDir = await resolvePluginSkillsDir(resolved)
      if (skillsDir) {
        const plugin = await readCursorPluginName(resolved)
        targets.push({ kind: 'root', path: skillsDir, source: 'plugin-path', plugin })
      }
      continue
    }
    targets.push({ kind: 'root', path: resolved, source: 'plugin-path' })
  }

  // First-party skills shipped with Copse (e.g. /checkup). Added last so a
  // user/project/plugin skill of the same name takes precedence (first-writer
  // wins during discovery), letting anyone override a built-in.
  const builtinRoot = getBuiltinSkillsRoot()
  if (builtinRoot && (await pathExists(builtinRoot))) {
    targets.push({ kind: 'root', path: builtinRoot, source: 'bundled' })
  }

  return { targets, switchedOffPlugins }
}

async function discoverSkillsRegistry(): Promise<SkillRegistrySnapshot> {
  if (!skillsEnabled()) {
    return { skills: [], failures: [], switchedOffPlugins: [] }
  }

  const skills = new Map<string, SkillMetadata>()
  const failures: SkillLoadFailure[] = []
  const { targets: discoveryTargets, switchedOffPlugins } = await collectDiscoveryTargets()

  for (const target of discoveryTargets) {
    if (target.kind === 'file') {
      await loadSkillFromFile(target.path, target.source, skills, failures, target.plugin)
      continue
    }
    await walkForFiles(
      target.path,
      (fileName) => fileName === 'SKILL.md',
      async (skillPath) => {
        await loadSkillFromFile(skillPath, target.source, skills, failures, target.plugin)
      },
    )
  }

  return {
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    failures,
    switchedOffPlugins,
  }
}

export async function refreshSkillsRegistry(): Promise<void> {
  const snapshot = await discoverSkillsRegistry()
  cachedSkills = [...snapshot.skills]
  cachedSkillLoadFailures = [...snapshot.failures]
  cachedSwitchedOffPlugins = [...snapshot.switchedOffPlugins]
}

export async function initSkillsRegistry(): Promise<void> {
  if (refreshPromise) await refreshPromise
  refreshPromise = refreshSkillsRegistry()
  await refreshPromise
  refreshPromise = null
  notifyRefreshContextEstimate()
}

/** Wait until an already-started discovery pass has populated the shared cache. */
export async function waitForSkillsRegistryRefresh(): Promise<void> {
  if (refreshPromise) await refreshPromise
}

/** Discover and scope the product skill catalog to one explicit headless run. */
export async function runWithDiscoveredSkills<T>(fn: () => Promise<T>): Promise<T> {
  const snapshot = await discoverSkillsRegistry()
  return scopedSkills.run(snapshot, fn)
}

export function listSkills(): SkillSummary[] {
  return activeSkills().map(({ name, description, source, skillPath, externalLinks }) => ({
    name,
    description,
    source,
    skillPath,
    externalLinks,
  }))
}

/**
 * Skills the model may be told about in its system-prompt catalog. Excludes any
 * skill whose frontmatter sets `disable-model-invocation: true` — those stay
 * user-only: they remain in {@link listSkills} (so the `/name` picker and manual
 * invocation still work) but are never advertised to the model, so it cannot
 * pick them up on its own.
 */
export function listModelInvocableSkills(): SkillCatalogEntry[] {
  return activeSkills()
    .filter((skill) => !skill.disableModelInvocation)
    .map(({ name, description, source, skillPath, externalLinks, plugin }) => ({
      name,
      description,
      source,
      skillPath,
      externalLinks,
      ...(plugin ? { plugin } : {}),
    }))
}

/** A skill as the system-prompt catalog advertises it. */
export type SkillCatalogEntry = SkillSummary & Pick<SkillMetadata, 'plugin'>

/**
 * Split a plugin-qualified request — `pstack/how` or `pstack:how` — into its
 * plugin and skill parts. `null` for a bare name.
 */
function splitQualifiedSkillName(name: string): { plugin: string; skill: string } | null {
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf(':'))
  if (separator <= 0 || separator === name.length - 1) return null
  return { plugin: name.slice(0, separator), skill: name.slice(separator + 1) }
}

/**
 * Look up a skill by its frontmatter name, or by `plugin/skill` (also
 * `plugin:skill`) when the named plugin is the one that ships it. Models see
 * plugin skills under a `.../plugins/<plugin>/skills/<skill>/` path and
 * sometimes ask for them qualified that way.
 */
export function getSkill(name: string): SkillMetadata | null {
  const skills = activeSkills()
  const exact = skills.find((skill) => skill.name === name)
  if (exact) return exact
  const qualified = splitQualifiedSkillName(name)
  if (!qualified) return null
  return (
    skills.find((skill) => skill.name === qualified.skill && skill.plugin === qualified.plugin) ??
    null
  )
}

/** How many available skill names `unknownSkillError` lists before summarizing the rest. */
const MAX_LISTED_SKILLS = 30
/** Keep the complete unknown-skill diagnostic below the existing 500-character contract. */
const MAX_LISTED_SKILLS_CHARS = 360

/**
 * Cheap Levenshtein distance for short skill names. Skill catalogs are small
 * and names are short, so the plain O(n·m) DP table is fine — no need for a
 * bounded/banded variant.
 */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dist: number[][] = []
  for (let i = 0; i < rows; i++) {
    const row = new Array<number>(cols).fill(0)
    row[0] = i
    dist.push(row)
  }
  for (let j = 0; j < cols; j++) {
    const row = dist[0]
    if (row) row[j] = j
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const current = dist[i]
      const prev = dist[i - 1]
      if (!current || !prev) continue
      current[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      )
    }
  }
  return dist[rows - 1]?.[cols - 1] ?? Math.max(a.length, b.length)
}

/**
 * The closest available skill name to an unknown request, for a "did you
 * mean" hint — a case-insensitive substring relationship (covers a
 * plural/prefix/suffix miss) or a small edit distance (covers a typo).
 * `null` when nothing available is close enough to be worth suggesting.
 */
function closestSkillName(name: string, available: readonly string[]): string | null {
  const lower = name.toLowerCase()
  let best: { name: string; score: number } | null = null
  for (const candidate of available) {
    const candidateLower = candidate.toLowerCase()
    const isSubstring = candidateLower.includes(lower) || lower.includes(candidateLower)
    const score = isSubstring ? 0 : levenshteinDistance(lower, candidateLower)
    const threshold = Math.max(2, Math.ceil(Math.max(lower.length, candidateLower.length) / 3))
    if (score <= threshold && (!best || score < best.score)) {
      best = { name: candidate, score }
    }
  }
  return best?.name ?? null
}

/** Sorted, deduplicated, length-capped, comma-separated skill names. */
function formatSkillNames(available: readonly string[]): string {
  const names = [...new Set(available)].sort((a, b) => a.localeCompare(b))
  const shown: string[] = []
  let listedChars = 0
  for (const name of names.slice(0, MAX_LISTED_SKILLS)) {
    const addedChars = name.length + (shown.length === 0 ? 0 : 2)
    if (shown.length > 0 && listedChars + addedChars > MAX_LISTED_SKILLS_CHARS) break
    shown.push(name)
    listedChars += addedChars
  }
  const remaining = names.length - shown.length
  const more = remaining > 0 ? ` (+${String(remaining)} more; see the Skills catalog)` : ''
  return `${shown.join(', ')}${more}`
}

function formatAvailableSkills(available: readonly string[]): string {
  if (available.length === 0) return 'No skills are currently available.'
  return `Available skills: ${formatSkillNames(available)}.`
}

/**
 * A bare plugin name (`pstack`) is a set of skills, not one skill. Name the
 * skills the model may read instead of reporting "unknown skill" and leaving it
 * to guess — the most common failed read_skill call in real threads.
 */
function pluginNameError(name: string): Error | null {
  const plugin = splitQualifiedSkillName(name)?.plugin ?? name
  if (activeSwitchedOffPlugins().includes(plugin)) {
    return new Error(
      `"${plugin}" is a bundled plugin that is switched off, so its skills are not loaded. ` +
        'The user can turn it on in Settings → Customise → Plugins; continue without it.',
    )
  }
  const pluginSkills = activeSkills().filter((skill) => skill.plugin === name)
  if (pluginSkills.length === 0) return null
  const readable = pluginSkills.filter((skill) => !skill.disableModelInvocation)
  const userOnly = pluginSkills.length - readable.length
  const userOnlyNote =
    userOnly > 0
      ? ` ${String(userOnly)} more ${userOnly === 1 ? 'is' : 'are'} user-invoked only (/name).`
      : ''
  if (readable.length === 0) {
    return new Error(
      `"${name}" is a plugin, not a skill, and none of its skills are offered to the agent.` +
        userOnlyNote,
    )
  }
  const first = readable[0]?.name ?? ''
  return new Error(
    `"${name}" is a plugin, not a skill. Read one of its skills by name ` +
      `(e.g. read_skill name "${first}"): ${formatSkillNames(readable.map((skill) => skill.name))}.` +
      userOnlyNote,
  )
}

function unknownSkillError(name: string): Error {
  // A name that discovery found but could not load (bad frontmatter, or a
  // frontmatter name/folder mismatch) is a registry bug, not a missing
  // skill — say so distinctly rather than telling the model no such skill
  // exists, which would just invite it to keep guessing (issue #1438).
  const failure = activeSkillLoadFailures().find((candidate) =>
    candidate.attemptedNames.includes(name),
  )
  if (failure) {
    return new Error(
      `Skill "${name}" is installed but failed to load: ${failure.reason} ` +
        `(${failure.skillPath}). This is a registry bug, not a missing skill — it cannot be ` +
        'read until the bundle is fixed; report the broken skill rather than retrying the name.',
    )
  }

  const pluginError = pluginNameError(name)
  if (pluginError) return pluginError

  const available = activeSkills().map((skill) => skill.name)
  const hint = closestSkillName(splitQualifiedSkillName(name)?.skill ?? name, available)
  const didYouMean = hint ? ` Did you mean "${hint}"?` : ''
  return new Error(`Unknown skill "${name}". ${formatAvailableSkills(available)}${didYouMean}`)
}

function isNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error['code'] === 'ENOENT' || error['code'] === 'ENOTDIR'
}

export async function readSkill(name: string, relativePath = 'SKILL.md'): Promise<SkillReadResult> {
  const skill = getSkill(name)
  if (!skill) throw unknownSkillError(name)

  const normalized = relativePath.replace(/^\/+/, '')
  const target = resolve(skill.skillRoot, normalized)
  const rel = relative(skill.skillRoot, target)
  if (rel.startsWith('..') || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Path outside skill root: ${relativePath}`)
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(target)
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        `Skill file not found: ${normalized} in "${skill.name}". ` +
          'The installed skill references a file that is missing; continue without it and report the broken reference.',
        { cause: error },
      )
    }
    throw error
  }
  if (stat.size > SKILL_READ_MAX_BYTES) {
    throw new Error(
      `Skill file too large (${String(stat.size)} bytes; max ${String(SKILL_READ_MAX_BYTES)}): ${relativePath}`,
    )
  }

  const [realRoot, realTarget] = await Promise.all([
    fsp.realpath(skill.skillRoot),
    fsp.realpath(target),
  ])
  const realRel = relative(realRoot, realTarget)
  if (realRel.startsWith('..') || realRel.split(/[/\\]/).includes('..')) {
    throw new Error(`Path outside skill root: ${relativePath}`)
  }

  const body = await fsp.readFile(realTarget, 'utf-8')
  return {
    name: skill.name,
    description: skill.description,
    skillRoot: skill.skillRoot,
    skillPath: realTarget,
    body,
    relativePath: normalized,
    missingReferences: skill.missingReferences,
  }
}

/** Test helper — replace cached skills without touching disk. */
export function setSkillsForTest(skills: SkillMetadata[]): void {
  cachedSkills = skills
  cachedSkillLoadFailures = []
  cachedSwitchedOffPlugins = []
}
