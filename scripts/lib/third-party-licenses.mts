/**
 * The third-party licence report the packaged app ships.
 *
 * Copse reaches users as one Electron bundle, and third-party code gets into it
 * three ways, each of which loses the licence differently:
 *
 * - **Bundled.** esbuild folds a devDependency (noVNC, xterm, Monaco, mermaid,
 *   the SDKs…) into `dist/**.js`. Only `/*!` comments survive; the package and
 *   its LICENSE file never reach the app. The esbuild metafile is the only
 *   complete record of what was folded in.
 * - **node_modules.** electron-builder copies the production dependency closure
 *   into app.asar. Those packages keep their own LICENSE files, but nothing
 *   collects them or tells a user they are there.
 * - **Vendored.** Fonts, the gortex binary, the Cursor skills snapshot, copied
 *   source (drauu, the simulator helpers) and the Electron runtime itself.
 *
 * {@link buildLicenseReport} gathers all three into one report, fails when a
 * shipped component has no licence text or is GPL-family only, and
 * {@link renderLicenseReportText} renders the plain-text file.
 */
import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  THIRD_PARTY_LICENSE_REPORT_VERSION,
  type ThirdPartyComponent,
  type ThirdPartyLicenseReport,
  type ThirdPartyShippedAs,
} from '../../src/shared/third-party-licenses.mts'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

/** A licence, notice or copyright file, read verbatim. */
export interface LicenseFile {
  name: string
  text: string
}

/** A component before its files are deduplicated into the report's text table. */
export interface CollectedComponent {
  name: string
  version: string
  license: string
  source: string | null
  shippedAs: ThirdPartyShippedAs[]
  partOf: string | null
  /** Why the component has no licence file, or where its text came from. */
  note?: string | undefined
  files: LicenseFile[]
}

const NODE_MODULES = `node_modules${sep}`

/**
 * Root-level files that carry licence terms or attribution. `NOTICE` matters as
 * much as `LICENSE`: Apache-2.0 §4(d) obliges a redistributor to pass it on, and
 * Monaco's `ThirdPartyNotices.txt` is the only credit for the VS Code code it
 * carries. Source files that merely share the stem (`license.js`) are not.
 */
const LICENSE_FILE_RE =
  /^(?:(?:un)?licen[cs]e|copying|notice|copyright|third[-_]?party[-_]?notices?|ofl)(?:[-_.][\w.-]*)?$/i
const NOT_A_LICENSE_EXTENSION_RE = /\.(?:[cm]?js|[cm]?ts|json|map|html?|css|d\.ts)$/i

export function isLicenseFileName(name: string): boolean {
  return LICENSE_FILE_RE.test(name) && !NOT_A_LICENSE_EXTENSION_RE.test(name)
}

/** Licence files directly in `dir`, named by their path relative to `base`. */
export function readLicenseFiles(dir: string, base: string = dir): LicenseFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const prefix = relative(base, dir)
  return names
    .filter((name) => isLicenseFileName(name) && statSync(join(dir, name)).isFile())
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name: prefix ? `${prefix.split(sep).join('/')}/${name}` : name,
      text: readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n'),
    }))
}

/**
 * Where packages keep the full texts their root LICENSE only points at: noVNC's
 * root LICENSE.txt is a summary that names `docs/LICENSE.MPL-2.0`.
 */
const LICENSE_SUBDIRS = ['docs', 'licenses', 'LICENSES', 'license']

/**
 * A package's licence files: its root, its licence subdirectories, and every
 * directory between the package root and a file esbuild bundled from it. The
 * last catches code a package vendors under its own tree with its own licence
 * (noVNC's `vendor/pako/LICENSE`), which only matters when that code is used.
 */
export function readPackageLicenseFiles(
  dir: string,
  bundledSubdirs: Iterable<string> = [],
): LicenseFile[] {
  const dirs = new Set([dir, ...LICENSE_SUBDIRS.map((sub) => join(dir, sub))])
  for (const subdir of bundledSubdirs) {
    for (let at = join(dir, subdir); at.startsWith(`${dir}${sep}`); at = dirname(at)) {
      dirs.add(at)
    }
  }
  const files = new Map<string, LicenseFile>()
  for (const at of dirs) {
    for (const file of readLicenseFiles(at, dir)) files.set(file.name, file)
  }
  return [...files.values()]
}

const personSchema = z.union([z.string(), z.object({ name: z.string().optional() })])
const repositorySchema = z.union([z.string(), z.object({ url: z.string().optional() })])
const licenseFieldSchema = z.union([z.string(), z.object({ type: z.string().optional() })])
const dependencyMapSchema = z.record(z.string(), z.string())

const manifestSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  license: licenseFieldSchema.optional(),
  licenses: z.array(licenseFieldSchema).optional(),
  repository: repositorySchema.optional(),
  homepage: z.string().optional(),
  author: personSchema.optional(),
  dependencies: dependencyMapSchema.optional(),
  optionalDependencies: dependencyMapSchema.optional(),
})

export type PackageManifest = z.infer<typeof manifestSchema>

export function readManifest(dir: string): PackageManifest {
  const path = join(dir, 'package.json')
  const manifest = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(manifestSchema))
  if (!manifest) throw new Error(`[licenses] unreadable package.json: ${path}`)
  return manifest
}

function licenseName(value: z.infer<typeof licenseFieldSchema>): string | undefined {
  return typeof value === 'string' ? value : value.type
}

/** The declared SPDX expression, including the legacy `licenses: [{ type }]` form. */
export function declaredLicense(manifest: PackageManifest): string {
  if (manifest.license !== undefined) {
    return licenseName(manifest.license) ?? 'UNKNOWN'
  }
  const legacy = (manifest.licenses ?? []).map(licenseName).filter((name) => name !== undefined)
  if (legacy.length === 1) return legacy[0] ?? 'UNKNOWN'
  return legacy.length > 1 ? `(${legacy.join(' OR ')})` : 'UNKNOWN'
}

export function sourceUrl(manifest: PackageManifest): string | null {
  const repository = manifest.repository
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (raw) {
    const url = raw
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^git@github\.com:/, 'https://github.com/')
    if (/^https?:\/\//.test(url)) return url
    if (/^github:/.test(url)) return `https://github.com/${url.slice('github:'.length)}`
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`
  }
  return manifest.homepage ?? null
}

/**
 * True when every way of satisfying `expression` is a GNU copyleft licence.
 * `MIT OR GPL-3.0` is fine (we take MIT); `MIT AND LGPL-2.1` is not.
 */
export function isGplFamilyOnly(expression: string): boolean {
  const alternatives = expression
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return alternatives.length > 0 && alternatives.every((part) => /\b(?:A|L)?GPL\b|GPL-/i.test(part))
}

/**
 * The package directory an esbuild input path belongs to, or null for a
 * first-party input. esbuild reports inputs relative to its working directory
 * (`node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/api.js`); the
 * package root is the segment after the last `node_modules/`, scoped or not.
 */
export function packageDirOfInput(input: string, cwd: string): string | null {
  const absolute = resolve(cwd, input.replace(/^[a-z-]+:/, ''))
  const index = absolute.lastIndexOf(NODE_MODULES)
  if (index < 0) return null
  const rest = absolute.slice(index + NODE_MODULES.length).split(sep)
  const [first, second] = rest
  if (first === undefined) return null
  const segments = first.startsWith('@') && second !== undefined ? [first, second] : [first]
  return join(absolute.slice(0, index + NODE_MODULES.length), ...segments)
}

/**
 * Best-effort SPDX id for a licence text, for components that declare none (Go
 * modules; the odd npm package with no `license` field). Order matters: the
 * LGPL text contains "GNU GENERAL PUBLIC LICENSE", and BSD-3 contains BSD-2.
 */
export function detectLicense(text: string): string {
  const flat = text.replace(/\s+/g, ' ')
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(flat)) return 'AGPL'
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(flat)) return 'LGPL'
  if (/GNU GENERAL PUBLIC LICENSE/i.test(flat)) return 'GPL'
  if (/Mozilla Public License,? (?:Version|v\.?) ?2\.0/i.test(flat)) return 'MPL-2.0'
  if (/Apache License,? Version 2\.0/i.test(flat)) return 'Apache-2.0'
  if (/Permission is hereby granted, free of charge/i.test(flat)) return 'MIT'
  if (/Permission to use, copy, modify, and\/?or distribute this software/i.test(flat)) return 'ISC'
  if (/Redistribution and use in source and binary forms/i.test(flat)) {
    return /Neither the name|name of the copyright holder/i.test(flat)
      ? 'BSD-3-Clause'
      : 'BSD-2-Clause'
  }
  if (/This is free and unencumbered software released into the public domain/i.test(flat)) {
    return 'Unlicense'
  }
  if (/SIL OPEN FONT LICENSE/i.test(flat)) return 'OFL-1.1'
  if (/Creative Commons.*CC0|CC0 1\.0 Universal/i.test(flat)) return 'CC0-1.0'
  if (/Creative Commons Attribution 4\.0/i.test(flat)) return 'CC-BY-4.0'
  if (/Boost Software License/i.test(flat)) return 'BSL-1.0'
  if (
    /zlib License|This software is provided 'as-is', without any express or implied warranty/i.test(
      flat,
    )
  ) {
    return 'Zlib'
  }
  return 'UNKNOWN'
}

interface MetafileLike {
  inputs: Record<string, unknown>
}

/**
 * Every third-party package directory whose files esbuild folded into a bundle,
 * with the package-relative directories those files came from.
 */
export function bundledPackageDirs(
  metafiles: readonly MetafileLike[],
  cwd: string,
): Map<string, Set<string>> {
  const dirs = new Map<string, Set<string>>()
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const dir = packageDirOfInput(input, cwd)
      if (!dir) continue
      const real = realpathSync(dir)
      const subdirs = dirs.get(real) ?? new Set<string>()
      subdirs.add(relative(dir, dirname(resolve(cwd, input))))
      dirs.set(real, subdirs)
    }
  }
  return dirs
}

/**
 * Node's resolution walk, bounded at `rootDir`. The bound matters: a worktree
 * lives inside the main checkout, and walking past it would find the parent's
 * node_modules and report packages this checkout does not ship.
 */
function resolvePackageDir(name: string, fromDir: string, rootDir: string): string | null {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dir === rootDir) return null
    const parent = dirname(dir)
    if (parent === dir || !`${parent}${sep}`.startsWith(`${rootDir}${sep}`)) return null
    dir = parent
  }
}

/**
 * The production dependency closure electron-builder copies into app.asar: the
 * app's `dependencies` and `optionalDependencies`, then each package's own, to
 * any depth. Peer dependencies are not followed — electron-builder does not
 * follow them either, which is what keeps sharp (an optional peer of Rampart's
 * transformers dependency) out of the app. A missing optional dependency is
 * skipped (it is platform-specific or failed to install); a missing required
 * one fails, because the packaged app would be missing it too.
 */
export function productionPackageDirs(rootDir: string): Set<string> {
  const root = realpathSync(rootDir)
  const seen = new Set<string>()
  const queue: { dir: string; manifest: PackageManifest }[] = [
    { dir: root, manifest: readManifest(root) },
  ]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { dir, manifest } = next
    const optional = manifest.optionalDependencies ?? {}
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(optional)])
    for (const name of names) {
      const resolved = resolvePackageDir(name, dir, root)
      if (resolved === null) {
        if (Object.hasOwn(optional, name)) continue
        throw new Error(
          `[licenses] ${name} (a dependency of ${relative(root, dir) || 'the app'}) is not installed`,
        )
      }
      if (seen.has(resolved)) continue
      seen.add(resolved)
      queue.push({ dir: resolved, manifest: readManifest(resolved) })
    }
  }
  return seen
}

/**
 * Copse's own workspace packages are bundled like any dependency but are not
 * third-party code: they live in this repository, outside node_modules.
 */
export function isFirstPartyDir(dir: string, rootDir: string): boolean {
  const root = realpathSync(rootDir)
  return dir.startsWith(`${root}${sep}`) && !dir.includes(`${sep}node_modules${sep}`)
}

export function collectPackage(
  dir: string,
  shippedAs: ThirdPartyShippedAs[],
  bundledSubdirs: Iterable<string> = [],
): CollectedComponent {
  const manifest = readManifest(dir)
  if (!manifest.name || !manifest.version) {
    throw new Error(`[licenses] ${dir}/package.json has no name or version`)
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: declaredLicense(manifest),
    source: sourceUrl(manifest),
    shippedAs,
    partOf: null,
    files: readPackageLicenseFiles(dir, bundledSubdirs),
  }
}

/** Package components for the bundled and node_modules sets, merged by directory. */
export function collectPackages(options: {
  rootDir: string
  bundled: ReadonlyMap<string, ReadonlySet<string>>
  production: ReadonlySet<string>
  copied?: ReadonlySet<string>
}): CollectedComponent[] {
  const how = new Map<string, Set<ThirdPartyShippedAs>>()
  const mark = (dirs: Iterable<string> | undefined, as: ThirdPartyShippedAs): void => {
    for (const dir of dirs ?? []) {
      if (isFirstPartyDir(dir, options.rootDir)) continue
      const set = how.get(dir) ?? new Set<ThirdPartyShippedAs>()
      set.add(as)
      how.set(dir, set)
    }
  }
  mark(options.bundled.keys(), 'bundled')
  mark(options.production, 'node_modules')
  mark(options.copied, 'copied')
  return [...how].map(([dir, set]) =>
    collectPackage(dir, [...set].sort(), options.bundled.get(dir) ?? []),
  )
}

export interface LicenseProblem {
  component: string
  problem: string
}

/** What must hold for every shipped component; empty when the report is sound. */
export function findLicenseProblems(components: readonly CollectedComponent[]): LicenseProblem[] {
  const problems: LicenseProblem[] = []
  for (const component of components) {
    const id = `${component.name}@${component.version}`
    if (component.files.length === 0 && !component.note) {
      problems.push({ component: id, problem: `no licence file (declares ${component.license})` })
    }
    if (isGplFamilyOnly(component.license)) {
      problems.push({ component: id, problem: `GPL-family licence ${component.license}` })
    }
  }
  return problems
}

/**
 * Deduplicate the licence texts (hundreds of packages share a byte-identical
 * MIT file only when the copyright line matches too, but the Apache and BSD
 * texts repeat a lot) and sort the components so the output is stable.
 */
export function buildLicenseReport(
  components: readonly CollectedComponent[],
): ThirdPartyLicenseReport {
  const merged = new Map<string, CollectedComponent>()
  for (const component of components) {
    const key = `${component.name}@${component.version}`
    const existing = merged.get(key)
    if (existing) {
      existing.shippedAs = [...new Set([...existing.shippedAs, ...component.shippedAs])].sort()
      if (existing.files.length === 0) existing.files = component.files
    } else {
      merged.set(key, { ...component, shippedAs: [...component.shippedAs] })
    }
  }
  const texts: string[] = []
  const textIndex = new Map<string, number>()
  const indexOf = (text: string): number => {
    const known = textIndex.get(text)
    if (known !== undefined) return known
    texts.push(text)
    textIndex.set(text, texts.length - 1)
    return texts.length - 1
  }
  const sorted = [...merged.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
  const out: ThirdPartyComponent[] = sorted.map((component) => ({
    name: component.name,
    version: component.version,
    license: component.license,
    source: component.source,
    shippedAs: component.shippedAs,
    partOf: component.partOf,
    ...(component.note ? { note: component.note } : {}),
    files: component.files.map((file) => ({ name: file.name, text: indexOf(file.text) })),
  }))
  return { version: THIRD_PARTY_LICENSE_REPORT_VERSION, components: out, texts }
}

const RULE = '='.repeat(78)

export function renderLicenseReportText(report: ThirdPartyLicenseReport, preamble: string): string {
  const parts = [preamble.trimEnd(), '']
  for (const component of report.components) {
    parts.push(RULE)
    parts.push(`${component.name} ${component.version}`)
    parts.push(`License: ${component.license}`)
    if (component.source) parts.push(`Source: ${component.source}`)
    parts.push(
      component.partOf
        ? `Included as: compiled into ${component.partOf}`
        : `Included as: ${component.shippedAs.join(', ')}`,
    )
    if (component.note) parts.push(`Note: ${component.note}`)
    for (const file of component.files) {
      parts.push(
        '',
        `--- ${file.name} ---`,
        '',
        (report.texts[file.text] ?? '').replace(/^\s*\n/, '').trimEnd(),
      )
    }
    parts.push('')
  }
  return `${parts.join('\n')}\n`
}
