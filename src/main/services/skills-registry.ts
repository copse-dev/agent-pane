import * as fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { getSetting } from './settings.ts'
import { getWorkspaceRoot } from './workspace.ts'
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

const SKILL_CONTAINER_DIRS = new Set(['.cursor', '.agents', '.claude'])
const SKIP_DIRS = new Set(['node_modules', '.git'])

let cachedSkills: SkillMetadata[] = []
let refreshPromise: Promise<void> | null = null

function skillsEnabled(): boolean {
  return getSetting<boolean>('skillsEnabled', true)
}

function userSkillRoots(): string[] {
  const home = homedir()
  return ['.cursor', '.agents', '.claude'].map((dir) => join(home, dir, 'skills'))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

async function walkForSkillRoots(dir: string, out: Set<string>): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.name === 'skills') {
      const parent = basename(dirname(full))
      if (SKILL_CONTAINER_DIRS.has(parent)) out.add(full)
    }
    await walkForSkillRoots(full, out)
  }
}

async function findPluginRoots(dir: string, out: string[]): Promise<void> {
  const manifest = join(dir, '.cursor-plugin', 'plugin.json')
  try {
    await fsp.access(manifest)
    out.push(dir)
    return
  } catch {
    /* not a plugin root */
  }

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    await findPluginRoots(join(dir, entry.name), out)
  }
}

async function discoverCursorPluginRoots(): Promise<string[]> {
  const pluginsRoot = join(homedir(), '.cursor', 'plugins')
  const roots: string[] = []
  for (const sub of ['local', 'cache']) {
    const base = join(pluginsRoot, sub)
    if (!(await pathExists(base))) continue
    await findPluginRoots(base, roots)
  }
  return roots
}

async function pluginSkillsDir(pluginRoot: string): Promise<string | null> {
  const manifestPath = join(pluginRoot, '.cursor-plugin', 'plugin.json')
  let skillsRel = './skills/'
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8')
    const json = JSON.parse(raw) as { skills?: string }
    if (json.skills) skillsRel = json.skills
  } catch {
    /* fall back to ./skills */
  }
  const resolved = resolve(pluginRoot, skillsRel)
  return (await pathExists(resolved)) ? resolved : null
}

async function walkForSkillFiles(
  root: string,
  onFound: (path: string) => Promise<void>,
): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walkForSkillFiles(full, onFound)
      continue
    }
    if (entry.name === 'SKILL.md') await onFound(full)
  }
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

  if (skills.has(parsed.name)) {
    console.warn(
      `[skills] Duplicate skill "${parsed.name}" — keeping first from ${skills.get(parsed.name)!.skillPath}`,
    )
    return
  }

  skills.set(parsed.name, toSkillMetadata(parsed, skillPath, source))
}

async function collectDiscoveryRoots(): Promise<Array<{ root: string; source: SkillSource }>> {
  const roots: Array<{ root: string; source: SkillSource }> = []

  for (const root of userSkillRoots()) {
    if (await pathExists(root)) roots.push({ root, source: 'user' })
  }

  const workspace = getWorkspaceRoot()
  if (workspace) {
    const projectRoots = new Set<string>()
    await walkForSkillRoots(workspace, projectRoots)
    for (const root of projectRoots) roots.push({ root, source: 'project' })
  }

  for (const pluginRoot of await discoverCursorPluginRoots()) {
    const skillsDir = await pluginSkillsDir(pluginRoot)
    if (skillsDir) roots.push({ root: skillsDir, source: 'plugin' })
  }

  const pluginPaths = getSetting<string[]>('skillPluginPaths', [])
  for (const pluginPath of pluginPaths) {
    const resolved = resolve(pluginPath)
    if (!(await pathExists(resolved))) continue
    const manifest = join(resolved, '.cursor-plugin', 'plugin.json')
    if (await pathExists(manifest)) {
      const skillsDir = await pluginSkillsDir(resolved)
      if (skillsDir) roots.push({ root: skillsDir, source: 'plugin-path' })
      continue
    }
    roots.push({ root: resolved, source: 'plugin-path' })
  }

  return roots
}

export async function refreshSkillsRegistry(): Promise<void> {
  if (!skillsEnabled()) {
    cachedSkills = []
    return
  }

  const skills = new Map<string, SkillMetadata>()
  const discoveryRoots = await collectDiscoveryRoots()

  for (const { root, source } of discoveryRoots) {
    await walkForSkillFiles(root, async (skillPath) => {
      await loadSkillFromFile(skillPath, source, skills)
    })
  }

  cachedSkills = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function initSkillsRegistry(): Promise<void> {
  if (refreshPromise) await refreshPromise
  refreshPromise = refreshSkillsRegistry()
  await refreshPromise
  refreshPromise = null
}

export function listSkills(): SkillSummary[] {
  return cachedSkills.map(({ name, description, source, skillPath }) => ({
    name,
    description,
    source,
    skillPath,
  }))
}

export function getSkill(name: string): SkillMetadata | null {
  return cachedSkills.find((skill) => skill.name === name) ?? null
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

  const body = await fsp.readFile(target, 'utf-8')
  return {
    name: skill.name,
    description: skill.description,
    skillRoot: skill.skillRoot,
    skillPath: target,
    body,
    relativePath: normalized,
  }
}

/** Test helper — replace cached skills without touching disk. */
export function setSkillsForTest(skills: SkillMetadata[]): void {
  cachedSkills = skills
}
