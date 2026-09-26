/**
 * Regenerate `vendor/licenses/gortex.json`: the licence texts of gortex and of
 * every Go module statically linked into the gortex binary the app ships.
 *
 * gortex's release archive carries only its own LICENSE.md. Its NOTICE (which
 * Apache-2.0 §4(d) says a redistributor must pass on) and the licences of the
 * ~340 modules compiled into it are in its source, not the archive — so Copse,
 * which redistributes the binary, has to collect them itself. The module list
 * comes from the binary's own build info, so it is exactly what was linked.
 *
 * Needs the Go toolchain and network (it runs `go mod download`, ~2 GB into the
 * module cache). Run after bumping GORTEX_VERSION:
 *
 *   pnpm sync:gortex-licenses [path/to/gortex]
 *
 * `scripts/third-party-licenses.test.ts` fails until the committed file matches
 * GORTEX_VERSION, and the build reads it into the shipped licence report.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { GORTEX_VERSION } from './lib/native-artifacts.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import { detectLicense, readLicenseFiles, type LicenseFile } from './lib/third-party-licenses.mts'
import { GORTEX_LICENSES_PATH, type GortexLicenses } from './third-party-vendored.mts'

const moduleRefSchema = z.object({ Path: z.string(), Version: z.string().optional() })
const buildInfoSchema = z.object({
  Main: moduleRefSchema,
  Deps: z.array(moduleRefSchema.extend({ Replace: moduleRefSchema.optional() })),
})

const downloadSchema = z.object({
  Path: z.string(),
  Version: z.string(),
  Dir: z.string().optional(),
  Error: z.string().optional(),
})

/**
 * gortex's forks of tree-sitter grammars drop the grammar's licence file. Where
 * a fork names the grammar it came from, that grammar's licence governs it.
 */
const FORK_UPSTREAMS: Readonly<Record<string, { upstream: string; licenseUrl: string }>> = {
  'github.com/gortexhq/tree-sitter-markdown': {
    upstream: 'https://github.com/tree-sitter-grammars/tree-sitter-markdown',
    licenseUrl:
      'https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-markdown/split_parser/LICENSE',
  },
  'github.com/gortexhq/tree-sitter-swift': {
    upstream: 'https://github.com/alex-pinkus/tree-sitter-swift',
    licenseUrl: 'https://raw.githubusercontent.com/alex-pinkus/tree-sitter-swift/main/LICENSE',
  },
}

/** Recorded, not guessed: the shipped report says plainly that the licence is unknown. */
const UNLICENSED_FORK_NOTE =
  "gortex's fork of this grammar publishes no licence file and does not name the grammar it " +
  'was taken from, so its licence cannot be determined from what gortex distributes.'

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`[gortex-licenses] ${url}: HTTP ${String(response.status)}`)
  return response.text()
}

function go(args: string[]): string {
  return execFileSync('go', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** `go mod download -json` prints one JSON object per module, concatenated. */
function parseJsonStream(text: string): unknown[] {
  const values: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) values.push(JSON.parse(text.slice(start, i + 1)) as unknown)
    }
  }
  return values
}

async function main(): Promise<void> {
  const binary = resolve(process.argv[2] ?? 'vendor/gortex/gortex')
  const info = safeJsonParse(
    go(['version', '-m', '-json', binary]),
    decodeWithSchema(buildInfoSchema),
  )
  if (!info) throw new Error(`[gortex-licenses] no Go build info in ${binary}`)
  if (info.Main.Version !== GORTEX_VERSION) {
    throw new Error(
      `[gortex-licenses] ${binary} is gortex ${String(info.Main.Version)}, but GORTEX_VERSION is ${GORTEX_VERSION}`,
    )
  }

  // A module replaced by a directory inside gortex's own tree has no module
  // zip; gortex's NOTICE is what documents those in-tree copies.
  const localReplacements: string[] = []
  const wanted: { path: string; version: string }[] = []
  for (const dep of info.Deps) {
    const target = dep.Replace ?? dep
    if (target.Path.startsWith('.') || !target.Version) {
      localReplacements.push(`${dep.Path} => ${target.Path}`)
      continue
    }
    wanted.push({ path: target.Path, version: target.Version })
  }

  const specs = [
    `${info.Main.Path}@${GORTEX_VERSION}`,
    ...wanted.map((m) => `${m.path}@${m.version}`),
  ]
  const downloads = parseJsonStream(go(['mod', 'download', '-json', ...specs])).map((value) => {
    const parsed = downloadSchema.safeParse(value)
    if (!parsed.success) throw new Error('[gortex-licenses] unexpected `go mod download` output')
    return parsed.data
  })
  const dirs = new Map<string, string>()
  for (const download of downloads) {
    if (download.Error || !download.Dir) {
      throw new Error(
        `[gortex-licenses] ${download.Path}@${download.Version}: ${String(download.Error)}`,
      )
    }
    dirs.set(`${download.Path}@${download.Version}`, download.Dir)
  }
  const filesOf = (path: string, version: string): LicenseFile[] => {
    const dir = dirs.get(`${path}@${version}`)
    if (!dir) throw new Error(`[gortex-licenses] ${path}@${version} was not downloaded`)
    return readLicenseFiles(dir)
  }

  const texts: string[] = []
  const indexOf = (text: string): number => {
    const known = texts.indexOf(text)
    if (known >= 0) return known
    texts.push(text)
    return texts.length - 1
  }
  const table = (files: LicenseFile[]): GortexLicenses['gortex']['files'] =>
    files.map((file) => ({ name: file.name, text: indexOf(file.text) }))

  const gortexFiles = filesOf(info.Main.Path, GORTEX_VERSION).filter(
    // Its THIRD_PARTY_NOTICES.md is a hand-kept module list that already drifts
    // from what is linked; the per-module entries below replace it.
    (file) => !/^third[-_]?party/i.test(file.name),
  )
  const modules: GortexLicenses['modules'] = []
  for (const { path, version } of wanted) {
    let files = filesOf(path, version)
    let note: string | undefined
    if (files.length === 0) {
      const fork = FORK_UPSTREAMS[path]
      if (fork) {
        files = [{ name: 'LICENSE', text: await fetchText(fork.licenseUrl) }]
        note = `gortex's fork publishes no licence file; this is the licence of ${fork.upstream}, which it names as its upstream.`
      } else if (path.startsWith('github.com/gortexhq/')) {
        note = UNLICENSED_FORK_NOTE
      } else {
        throw new Error(`[gortex-licenses] ${path}@${version} has no licence file`)
      }
    }
    const detected = [...new Set(files.map((file) => detectLicense(file.text)))].filter(
      (id) => id !== 'UNKNOWN',
    )
    modules.push({
      path,
      version,
      license: detected.length > 0 ? detected.join(' AND ') : 'NOASSERTION',
      ...(note ? { note } : {}),
      files: table(files),
    })
  }
  modules.sort((a, b) => a.path.localeCompare(b.path))

  const out: GortexLicenses = {
    gortexVersion: GORTEX_VERSION,
    source: `https://github.com/zzet/gortex/tree/${GORTEX_VERSION}`,
    gortex: { license: 'Apache-2.0', files: table(gortexFiles) },
    localReplacements: localReplacements.sort(),
    modules,
    texts,
  }
  writeFileSync(GORTEX_LICENSES_PATH, `${JSON.stringify(out, null, 2)}\n`)
  const missing = modules.filter((m) => m.files.length === 0).map((m) => `${m.path}@${m.version}`)
  console.log(
    `[gortex-licenses] wrote ${GORTEX_LICENSES_PATH}: ${String(modules.length)} modules, ${String(texts.length)} distinct texts`,
  )
  if (missing.length > 0) {
    console.warn(`[gortex-licenses] modules with no licence file:\n  ${missing.join('\n  ')}`)
  }
}

await main()
