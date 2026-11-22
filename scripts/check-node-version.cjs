'use strict'

// Runs as `preinstall` and as the first postinstall step, before any dependency
// can be relied on, so it stays plain CommonJS that still parses on the old Node
// releases whose version it rejects.

const { spawnSync } = require('node:child_process')
const { existsSync, realpathSync } = require('node:fs')
const path = require('node:path')

// The first release of each supported line with the 2026-10-21 security fixes,
// which include CVE-2026-111497 (code execution through crafted Brotli input).
// Odd lines got no fix; a major newer than every entry shipped after them.
const FIXED_RELEASES = [
  [24, 22, 1],
  [26, 12, 1],
]

function parseVersion(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10))
}

function isAtLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    const current = version[i] ?? 0
    const required = minimum[i] ?? 0
    if (current > required) return true
    if (current < required) return false
  }
  return true
}

function isSupportedVersion(version) {
  const current = parseVersion(version)
  const fixedOnLine = FIXED_RELEASES.find(([major]) => major === current[0])
  const newestLine = FIXED_RELEASES[FIXED_RELEASES.length - 1][0]
  return fixedOnLine ? isAtLeast(current, fixedOnLine) : current[0] > newestLine
}

// The Developer ID team that signs the nodejs.org macOS builds nvm, fnm and the
// official installer use. Those builds carry the disable-library-validation
// entitlement, so they load third-party addons despite the hardened runtime.
const OPENJS_TEAM_ID = 'HX7739G8FX'
const DISABLE_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation'

// dyld's wording when library validation refuses a file signed by another team
// (or by nobody): "code signature in <…> '<file>' not valid for use in process:
// mapping process and mapped file (non-platform) have different Team IDs".
const LIBRARY_VALIDATION_MARKERS = ['not valid for use in process', 'different Team IDs']

// Native addons the macOS dependency tree carries, relative to the repository
// root. @electron-internal/extract-zip ships its universal (arm64 + x86_64)
// macOS binary on every platform, so it also loads under Rosetta; fsevents is a
// macOS-only optional dependency hoisted into pnpm's virtual store.
const PROBE_ADDONS = [
  'packages/extract-zip/node_modules/@electron-internal/extract-zip/index.darwin-universal.node',
  'node_modules/.pnpm/node_modules/@electron-internal/extract-zip/index.darwin-universal.node',
  'node_modules/.pnpm/node_modules/fsevents/fsevents.node',
]

/**
 * The part of a dlopen error message that shows library validation refused the
 * file, or null when the failure has another cause (wrong architecture, a
 * damaged or missing file) that says nothing about the Node binary.
 */
function libraryValidationRefusal(error) {
  if (error === null || typeof error !== 'object') return null
  if (error.code !== 'ERR_DLOPEN_FAILED' || typeof error.message !== 'string') return null
  const { message } = error
  if (!LIBRARY_VALIDATION_MARKERS.some((marker) => message.includes(marker))) return null
  // Gatekeeper refusing a quarantined file uses the same "not valid for use in
  // process" lead-in, even in a Node that loads other teams' code.
  if (message.includes('disallowed by system policy')) return null
  // Keep dyld's own clause, including the parenthesised "(non-platform)".
  const clause = /not valid for use in process(?:[^()]|\([^()]*\))*/.exec(message)
  return clause ? clause[0].trim() : 'mapping process and mapped file have different Team IDs'
}

/**
 * Why `codesign -d --verbose --entitlements -` output (stderr and stdout
 * together) shows a binary that refuses third-party native modules, or null
 * when it does not. Deliberately conservative: an ad-hoc or unsigned build, a
 * nodejs.org build, or any binary allowed to load other teams' code passes.
 */
function codesignRefusal(output) {
  const flagsMatch = /\bflags=(0x[0-9a-f]+)\(([^)]*)\)/i.exec(output)
  const flags = flagsMatch ? flagsMatch[2].split(',') : []
  const teamMatch = /^TeamIdentifier=(.*)$/m.exec(output)
  const teamId = teamMatch ? teamMatch[1].trim() : ''
  // The hardened runtime implies library validation; the flag can also be set
  // on its own. Either way the entitlement is treated as switching it off.
  const validates = flags.includes('runtime') || flags.includes('library-validation')
  if (!flagsMatch || !validates || output.includes(DISABLE_LIBRARY_VALIDATION)) return null
  if (!/^[A-Z0-9]{10}$/.test(teamId) || teamId === OPENJS_TEAM_ID) return null
  return `codesign reports flags=${flagsMatch[1]}(${flagsMatch[2]}), TeamIdentifier=${teamId} and no ${DISABLE_LIBRARY_VALIDATION} entitlement`
}

/**
 * On macOS, decide whether the Node at `execPath` can load third-party native
 * addons. Loading a real addon is the evidence; the code signature is read only
 * when no addon is installed yet (a fresh clone at preinstall) or none gives a
 * clear answer. Returns the evidence for a refusal, or null to continue.
 */
function diagnoseNativeAddonLoading({ platform, execPath, addons, exists, dlopen, codesign }) {
  if (platform !== 'darwin') return null
  for (const addon of addons) {
    if (!exists(addon)) continue
    try {
      dlopen(addon)
      return null
    } catch (error) {
      const refusal = libraryValidationRefusal(error)
      if (refusal !== null) return { addon, evidence: refusal }
    }
  }
  const output = codesign(execPath)
  const refusal = output === null ? null : codesignRefusal(output)
  return refusal === null ? null : { addon: null, evidence: refusal }
}

/** The PATH entry whose `node` is this binary, or null when none resolves to it. */
function pathEntryProviding(execPath, pathValue, realpath) {
  let target
  try {
    target = realpath(execPath)
  } catch {
    return null
  }
  for (const entry of pathValue.split(':')) {
    if (!entry) continue
    try {
      if (realpath(path.posix.join(entry, 'node')) === target) return entry
    } catch {
      // No node in this entry.
    }
  }
  return null
}

function nativeAddonRefusalMessage({ execPath, pathEntry, refusal }) {
  const lines = [
    'This Node cannot load the native modules this install needs:',
    '',
    `  ${execPath}`,
    '',
    'The binary refuses unsigned or third-party native modules (.node files):',
    'macOS library validation lets it load only code signed by Apple or by its',
    'own team. pnpm and its install scripts run on the first `node` on PATH, so',
    'every native step in postinstall would fail with ERR_DLOPEN_FAILED.',
  ]
  const bundleEnd = execPath.indexOf('.app/Contents/')
  if (bundleEnd >= 0) {
    lines.push('', `A desktop app bundled this Node: ${execPath.slice(0, bundleEnd + 4)}`)
  }
  if (pathEntry !== null) lines.push(`PATH reaches it through ${pathEntry}`)
  lines.push(
    '',
    "Put nvm's or Homebrew's Node first on PATH, then rerun `pnpm install`:",
    '',
    '  nvm use                                  # nvm, from the repo root (fnm: fnm use)',
    '  export PATH="$(brew --prefix)/bin:$PATH" # Homebrew',
    '  which -a node                            # pnpm runs on the first one listed',
    '',
    'Those fix the current shell. For new shells, edit your shell profile so',
    `${pathEntry ?? 'the PATH directory that provides this node'} comes after nvm's or`,
    "Homebrew's directory, or remove it from PATH.",
    '',
    refusal.addon === null ? 'Evidence:' : `Evidence: dlopen refused ${refusal.addon}`,
    `  ${refusal.evidence}`,
  )
  return lines.join('\n')
}

function readCodesign(execPath) {
  const result = spawnSync(
    '/usr/bin/codesign',
    ['-d', '--verbose=1', '--entitlements', '-', execPath],
    { encoding: 'utf8', timeout: 10_000 },
  )
  if (result.error || result.status !== 0) return null
  return `${result.stderr}\n${result.stdout}`
}

function main() {
  if (!isSupportedVersion(process.versions.node)) {
    console.error(
      [
        `Node ${process.versions.node} is not supported: use 24.22.1+ on the 24 line, 26.12.1+ on the 26 line, or a newer major.`,
        '',
        'Earlier releases lack the fix for CVE-2026-111497 (Brotli decoder remote code execution).',
        'This project targets the Node 24 LTS line.',
        'Run `nvm install` / `nvm use` or `fnm install` / `fnm use` from the repo root, then rerun `pnpm install`.',
      ].join('\n'),
    )
    process.exit(1)
  }

  const root = path.resolve(__dirname, '..')
  const refusal = diagnoseNativeAddonLoading({
    platform: process.platform,
    execPath: process.execPath,
    addons: PROBE_ADDONS.map((addon) => path.join(root, addon)),
    exists: existsSync,
    dlopen: (addon) => process.dlopen({ exports: {} }, addon),
    codesign: readCodesign,
  })
  if (refusal !== null) {
    const pathEntry = pathEntryProviding(process.execPath, process.env.PATH ?? '', realpathSync)
    console.error(nativeAddonRefusalMessage({ execPath: process.execPath, pathEntry, refusal }))
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = {
  codesignRefusal,
  diagnoseNativeAddonLoading,
  isSupportedVersion,
  libraryValidationRefusal,
  nativeAddonRefusalMessage,
  pathEntryProviding,
}
