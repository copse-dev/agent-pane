/**
 * Third-party components that reach the packaged app without going through a
 * package manager, and the few npm packages whose published tarball omits the
 * licence file it declares. `scripts/lib/third-party-licenses.mts` finds the
 * rest (bundled and node_modules packages) on its own.
 *
 * `scripts/third-party-licenses.test.ts` keeps this list honest: every licence
 * file tracked under src/, assets/ and vendor/ has to belong to an entry here,
 * and every `node_modules/<pkg>` the build copies from has to be in
 * {@link COPIED_PACKAGES}.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import {
  detectLicense,
  readLicenseFiles,
  type CollectedComponent,
  type LicenseFile,
} from './lib/third-party-licenses.mts'

interface VendoredComponent {
  name: string
  version: string
  license: string
  source: string
  /** Repo-relative licence files; each must exist. */
  licenseFiles: string[]
}

/** Checked-in third-party code and assets. */
export const VENDORED_COMPONENTS: readonly VendoredComponent[] = [
  {
    name: 'Pliant',
    version: 'Google Fonts',
    license: 'OFL-1.1',
    source: 'https://fonts.google.com/specimen/Pliant',
    licenseFiles: ['assets/fonts/OFL-Pliant.txt'],
  },
  {
    name: 'Averia Serif Libre',
    version: 'Google Fonts',
    license: 'OFL-1.1',
    source: 'https://fonts.google.com/specimen/Averia+Serif+Libre',
    licenseFiles: ['assets/fonts/OFL-Averia-Serif-Libre.txt'],
  },
  {
    // Copied source, modified; see src/renderer/drawing/drauu/README.md.
    name: 'drauu',
    version: '1.0.0 (modified)',
    license: 'MIT',
    source: 'https://github.com/antfu/drauu',
    licenseFiles: ['src/renderer/drawing/drauu/LICENSE'],
  },
  {
    // The Simulator capture/input helpers, compiled from source on the user's Mac.
    name: 'claude-sim',
    version: 'adapted',
    license: 'MIT',
    source: 'https://github.com/Jake-Nguyen123/claude-sim',
    licenseFiles: ['src/main/services/simulator-desktop/native/CLAUDE-SIM-LICENSE.txt'],
  },
  {
    name: 'codex-plusplus-ios-simulator',
    version: 'adapted',
    license: 'MIT',
    source: 'https://github.com/b-nnett/codex-plusplus-ios-simulator',
    licenseFiles: ['src/main/services/simulator-desktop/native/UPSTREAM-LICENSE.txt'],
  },
]

interface LicenseOverride {
  /** The licence the package must still declare, so a relicensed release is re-checked. */
  declared: string
  /** Reported instead of `declared`, only for a package that declares none. */
  license?: string
  /** Repo-relative text for a package that ships none; omitted when only `license` is fixed. */
  licenseFile?: string
  /** Where the text came from. */
  origin: string
}

/**
 * npm packages that ship without the licence text they declare. Keyed by name,
 * not version: a new release that still ships no file keeps the same upstream
 * text, and a changed `license` field fails the build instead.
 */
export const LICENSE_OVERRIDES: Readonly<Record<string, LicenseOverride>> = {
  standardwebhooks: {
    declared: 'MIT',
    licenseFile: 'vendor/licenses/npm/standardwebhooks/LICENSE',
    origin: 'standard-webhooks/standard-webhooks libraries/LICENSE (covers the JS library)',
  },
  boolbase: {
    declared: 'ISC',
    licenseFile: 'vendor/licenses/npm/boolbase/LICENSE',
    origin: 'fb55/boolbase LICENSE',
  },
  saxes: {
    declared: 'ISC',
    licenseFile: 'vendor/licenses/npm/saxes/LICENSE',
    origin: 'lddubeau/saxes LICENSE',
  },
  fastdom: {
    declared: 'MIT',
    licenseFile: 'vendor/licenses/npm/fastdom/LICENSE',
    origin: 'the "License" section of wilsonpage/fastdom README.md (the repo has no LICENSE file)',
  },
  '@napi-rs/keyring-darwin-arm64': {
    declared: 'MIT',
    licenseFile: 'vendor/licenses/npm/@napi-rs/keyring/LICENSE',
    origin: 'Brooooooklyn/keyring-node LICENSE (the platform binary packages ship none)',
  },
  '@napi-rs/keyring-darwin-x64': {
    declared: 'MIT',
    licenseFile: 'vendor/licenses/npm/@napi-rs/keyring/LICENSE',
    origin: 'Brooooooklyn/keyring-node LICENSE (the platform binary packages ship none)',
  },
  'lazy-val': {
    declared: 'MIT',
    licenseFile: 'vendor/licenses/npm/lazy-val/LICENSE',
    origin:
      'the MIT licence text naming the package.json author; develar/lazy-val has no licence file',
  },
  'bplist-parser': {
    declared: 'MIT',
    licenseFile: 'vendor/licenses/npm/bplist-parser/LICENSE',
    origin: 'the "License" section of joeferner/node-bplist-parser README.md',
  },
  '@sentry/server-utils': {
    declared: 'MIT',
    licenseFile: 'vendor/licenses/npm/@sentry/server-utils/LICENSE',
    origin:
      'getsentry/sentry-javascript LICENSE (the monorepo licence every @sentry package ships)',
  },
  khroma: {
    declared: 'UNKNOWN',
    license: 'MIT',
    origin: 'its package.json has no license field; the shipped `license` file is MIT',
  },
}

/**
 * Packages the build copies files out of, besides bundling: `copy-monaco-workers`
 * copies Monaco's `vs/` tree, and build.mts copies the material icon SVGs.
 */
export const COPIED_PACKAGES = ['monaco-editor', 'vscode-material-icons'] as const

export const GORTEX_LICENSES_PATH = resolve('vendor/licenses/gortex.json')

/** The Cursor skills snapshot build.mts copies into dist/resources. */
const CURSOR_SKILLS_DIR = 'vendor/bundled-cursor-skills'

const fileRefSchema = z.object({ name: z.string(), text: z.number().int().nonnegative() })

const gortexLicensesSchema = z.object({
  gortexVersion: z.string(),
  source: z.string(),
  gortex: z.object({ license: z.string(), files: z.array(fileRefSchema) }),
  localReplacements: z.array(z.string()),
  modules: z.array(
    z.object({
      path: z.string(),
      version: z.string(),
      license: z.string(),
      /** Why a module has no licence file of its own, or where its text came from. */
      note: z.string().optional(),
      files: z.array(fileRefSchema),
    }),
  ),
  texts: z.array(z.string()),
})

export type GortexLicenses = z.infer<typeof gortexLicensesSchema>

export function readGortexLicenses(path = GORTEX_LICENSES_PATH): GortexLicenses {
  const parsed = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(gortexLicensesSchema))
  if (!parsed) throw new Error(`[licenses] ${path} does not match the gortex licence schema`)
  return parsed
}

function readRepoFile(rootDir: string, path: string): LicenseFile {
  const absolute = join(rootDir, path)
  if (!existsSync(absolute)) throw new Error(`[licenses] missing licence file ${path}`)
  return { name: path.split('/').at(-1) ?? path, text: readFileSync(absolute, 'utf8') }
}

/** gortex, and each Go module compiled into it. */
export function gortexComponents(licenses: GortexLicenses): CollectedComponent[] {
  const files = (refs: GortexLicenses['gortex']['files']): LicenseFile[] =>
    refs.map((ref) => {
      const text = licenses.texts[ref.text]
      if (text === undefined)
        throw new Error(`[licenses] gortex.json has no text ${String(ref.text)}`)
      return { name: ref.name, text }
    })
  return [
    {
      name: 'gortex',
      version: licenses.gortexVersion,
      license: licenses.gortex.license,
      source: licenses.source,
      shippedAs: ['vendored'],
      partOf: null,
      files: files(licenses.gortex.files),
    },
    ...licenses.modules.map((module) => ({
      name: module.path,
      version: module.version,
      license: module.license,
      source: `https://pkg.go.dev/${module.path}@${module.version}`,
      shippedAs: ['vendored' as const],
      partOf: 'gortex',
      ...(module.note ? { note: module.note } : {}),
      files: files(module.files),
    })),
  ]
}

const pluginManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  license: z.string().optional(),
})

/** One component per plugin in the Cursor skills snapshot; each keeps its own LICENSE. */
export function cursorPluginComponents(rootDir: string): CollectedComponent[] {
  const pluginsDir = join(rootDir, CURSOR_SKILLS_DIR, 'plugins')
  const source = safeJsonParse(
    readFileSync(join(rootDir, CURSOR_SKILLS_DIR, 'SOURCE.json'), 'utf8'),
    decodeWithSchema(z.object({ repository: z.string(), commit: z.string() })),
  )
  return readdirSync(pluginsDir)
    .sort()
    .map((plugin) => {
      const dir = join(pluginsDir, plugin)
      const manifest = safeJsonParse(
        readFileSync(join(dir, '.cursor-plugin', 'plugin.json'), 'utf8'),
        decodeWithSchema(pluginManifestSchema),
      )
      const files = readLicenseFiles(dir)
      return {
        name: `cursor/plugins: ${manifest?.name ?? plugin}`,
        version: manifest?.version ?? source?.commit.slice(0, 12) ?? 'unknown',
        license: manifest?.license ?? detectLicense(files[0]?.text ?? ''),
        source: source ? `${source.repository}/tree/${source.commit}/${plugin}` : null,
        shippedAs: ['vendored' as const],
        partOf: null,
        files,
      }
    })
}

/**
 * The Electron runtime. electron-builder copies only `Electron.app`, which
 * carries neither Electron's MIT licence nor Chromium's 20 MB of third-party
 * notices (`LICENSES.chromium.html`); both sit beside it in electron's `dist/`.
 * The build copies the Chromium notices next to the report ({@link ELECTRON_NOTICES}).
 */
export const ELECTRON_NOTICES = 'node_modules/electron/dist/LICENSES.chromium.html'

export function electronComponent(rootDir: string): CollectedComponent {
  const dir = join(rootDir, 'node_modules', 'electron')
  const version = safeJsonParse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
    decodeWithSchema(z.object({ version: z.string() })),
  )?.version
  if (!version) throw new Error('[licenses] cannot read the installed electron version')
  const distVersion = readFileSync(join(dir, 'dist', 'version'), 'utf8').trim()
  if (distVersion !== version) {
    // A stale ~/.copse/cache/electron-dist link would ship the wrong notices.
    throw new Error(`[licenses] electron ${version} has a ${distVersion} dist/ — reinstall`)
  }
  return {
    name: 'electron',
    version,
    license: 'MIT',
    source: 'https://github.com/electron/electron',
    shippedAs: ['vendored'],
    partOf: null,
    files: [readRepoFile(rootDir, 'node_modules/electron/dist/LICENSE')],
  }
}

export function vendoredComponents(rootDir: string): CollectedComponent[] {
  return [
    ...VENDORED_COMPONENTS.map((component) => ({
      name: component.name,
      version: component.version,
      license: component.license,
      source: component.source,
      shippedAs: ['vendored' as const],
      partOf: null,
      files: component.licenseFiles.map((path) => readRepoFile(rootDir, path)),
    })),
    ...cursorPluginComponents(rootDir),
    ...gortexComponents(readGortexLicenses(join(rootDir, 'vendor/licenses/gortex.json'))),
    electronComponent(rootDir),
  ]
}

/** Fill in the licence text (or id) a package's tarball is missing. */
export function applyLicenseOverrides(
  components: CollectedComponent[],
  rootDir: string,
  overrides: Readonly<Record<string, LicenseOverride>> = LICENSE_OVERRIDES,
): CollectedComponent[] {
  return components.map((component) => {
    if (!Object.hasOwn(overrides, component.name)) return component
    const override = overrides[component.name]
    if (!override) return component
    if (component.license !== override.declared) {
      throw new Error(
        `[licenses] ${component.name} now declares ${component.license}, not ${override.declared}; ` +
          'recheck its entry in LICENSE_OVERRIDES (scripts/third-party-vendored.mts)',
      )
    }
    if (override.licenseFile && component.files.length > 0) {
      throw new Error(
        `[licenses] ${component.name}@${component.version} ships a licence file now; ` +
          'drop its LICENSE_OVERRIDES entry',
      )
    }
    return {
      ...component,
      license: override.license ?? component.license,
      note: override.licenseFile
        ? `The published package omits its licence file; this text is from ${override.origin}.`
        : `The published package declares no licence; ${override.origin}.`,
      files: override.licenseFile ? [readRepoFile(rootDir, override.licenseFile)] : component.files,
    }
  })
}

/**
 * `pnpm patch` output: `patches/@scope__name@1.2.3.patch`. Apache-2.0 §4(b)
 * requires modified files to say they were changed, so every shipped package
 * Copse patches is marked as modified in the report, naming the patch.
 */
export function markPatchedPackages(
  components: CollectedComponent[],
  rootDir: string,
): CollectedComponent[] {
  const patchesDir = join(rootDir, 'patches')
  const patched = new Map<string, string>()
  for (const file of existsSync(patchesDir) ? readdirSync(patchesDir) : []) {
    const match = /^(.+)@([^@]+)\.patch$/.exec(file)
    if (match?.[1] && match[2]) patched.set(`${match[1].replace('__', '/')}@${match[2]}`, file)
  }
  return components.map((component) => {
    const file = patched.get(`${component.name}@${component.version}`)
    if (!file) return component
    const modified = `Modified: Copse applies patches/${file} to this package.`
    return { ...component, note: component.note ? `${component.note} ${modified}` : modified }
  })
}
