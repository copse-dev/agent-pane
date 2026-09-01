import { AsyncLocalStorage } from 'node:async_hooks'
import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { discoverCursorPluginRoots, resolvePluginSkillsDir } from './cursor-plugins.ts'
import { listBundledCursorPluginRoots } from './bundled-cursor-skills.ts'
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
import { notifyRefreshContextEstimate } from '../context-estimate-notify.ts'

/** Max bytes read from a skill file (auto-approved, outside workspace). */
export const SKILL_READ_MAX_BYTES = READ_FILE_LIMITS_CEILING.maxChars * 4

const SKILL_CONTAINER_DIRS = new Set(['.cursor', '.agents', '.claude'])

let cachedSkills: SkillMetadata[] = []
let refreshPromise: Promise<void> | null = null
const scopedSkills = new AsyncLocalStorage<readonly SkillMetadata[]>()

function activeSkills(): readonly SkillMetadata[] {
  return scopedSkills.getStore() ?? cachedSkills
}

function skillsEnabled(): boolean {
  return getSetting<boolean>('skillsEnabled', true)
}

function userSkillRoots(): string[] {
  const home = homedir()
  return ['.cursor', '.agents', '.claude'].map((dir) => join(home, dir, 'skills'))
}

async function loadSkillFromFile(
  skillPath: string,
  source: SkillSource,
  skills: Map<string, SkillMetadata>,
): Promise<void> {
  let raw: string
  try {
    raw = await fsp.readFile(skillPath, 'utf-8')
  } catch {
    return
  }

  const split = splitSkillMarkdown(raw)
  if (!split) {
    console.warn(`[skills] Skipping ${skillPath}: missing frontmatter`)
    return
  }

  const parsed = parseSkillFrontmatter(split.frontmatter)
  if (!parsed) {
    console.warn(`[skills] Skipping ${skillPath}: invalid frontmatter`)
    return
  }

  if (!folderNameMatchesSkill(skillPath, parsed.name)) {
    console.warn(
      `[skills] Skipping ${skillPath}: name "${parsed.name}" does not match folder "${basename(dirname(skillPath))}"`,
    )
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
  skills.set(parsed.name, toSkillMetadata(parsed, skillPath, source, externalLinks))
}

async function collectDiscoveryRoots(): Promise<Array<{ root: string; source: SkillSource }>> {
  const roots: Array<{ root: string; source: SkillSource }> = []

  for (const root of userSkillRoots()) {
    if (await pathExists(root)) roots.push({ root, source: 'user' })
  }

  if (getSetting<boolean>('bundledCursorSkillsEnabled', true)) {
    for (const pluginRoot of await listBundledCursorPluginRoots()) {
      const skillsDir = await resolvePluginSkillsDir(pluginRoot)
      if (skillsDir) roots.push({ root: skillsDir, source: 'bundled' })
    }
  }

  const workspace = getWorkspaceRoot()
  if (workspace) {
    const projectRoots = new Set<string>()
    await walkForContainerRoots(
      workspace,
      { containerDirs: SKILL_CONTAINER_DIRS, leafName: 'skills' },
      projectRoots,
    )
    for (const root of projectRoots) roots.push({ root, source: 'project' })
  }

  for (const pluginRoot of await discoverCursorPluginRoots()) {
    const skillsDir = await resolvePluginSkillsDir(pluginRoot)
    if (skillsDir) roots.push({ root: skillsDir, source: 'plugin' })
  }

  const pluginPaths = getSetting<string[]>('skillPluginPaths', [])
  for (const pluginPath of pluginPaths) {
    const resolved = resolve(pluginPath)
    if (!(await pathExists(resolved))) continue
    const manifest = join(resolved, '.cursor-plugin', 'plugin.json')
    if (await pathExists(manifest)) {
      const skillsDir = await resolvePluginSkillsDir(resolved)
      if (skillsDir) roots.push({ root: skillsDir, source: 'plugin-path' })
      continue
    }
    roots.push({ root: resolved, source: 'plugin-path' })
  }

  // First-party skills shipped with Copse (e.g. /checkup). Added last so a
  // user/project/plugin skill of the same name takes precedence (first-writer
  // wins during discovery), letting anyone override a built-in.
  const builtinRoot = getBuiltinSkillsRoot()
  if (builtinRoot && (await pathExists(builtinRoot))) {
    roots.push({ root: builtinRoot, source: 'bundled' })
  }

  return roots
}

async function discoverSkillsRegistry(): Promise<SkillMetadata[]> {
  if (!skillsEnabled()) {
    return []
  }

  const skills = new Map<string, SkillMetadata>()
  const discoveryRoots = await collectDiscoveryRoots()

  for (const { root, source } of discoveryRoots) {
    await walkForFiles(
      root,
      (fileName) => fileName === 'SKILL.md',
      async (skillPath) => {
        await loadSkillFromFile(skillPath, source, skills)
      },
    )
  }

  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function refreshSkillsRegistry(): Promise<void> {
  cachedSkills = await discoverSkillsRegistry()
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
  const skills = await discoverSkillsRegistry()
  return scopedSkills.run(skills, fn)
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
export function listModelInvocableSkills(): SkillSummary[] {
  return activeSkills()
    .filter((skill) => !skill.disableModelInvocation)
    .map(({ name, description, source, skillPath, externalLinks }) => ({
      name,
      description,
      source,
      skillPath,
      externalLinks,
    }))
}

export function getSkill(name: string): SkillMetadata | null {
  return activeSkills().find((skill) => skill.name === name) ?? null
}

export async function readSkill(name: string, relativePath = 'SKILL.md'): Promise<SkillReadResult> {
  const skill = getSkill(name)
  if (!skill) throw new Error(`Unknown skill: ${name}`)

  const normalized = relativePath.replace(/^\/+/, '')
  const target = resolve(skill.skillRoot, normalized)
  const rel = relative(skill.skillRoot, target)
  if (rel.startsWith('..') || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Path outside skill root: ${relativePath}`)
  }

  const stat = await fsp.stat(target)
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
  }
}

/** Test helper — replace cached skills without touching disk. */
export function setSkillsForTest(skills: SkillMetadata[]): void {
  cachedSkills = skills
}
