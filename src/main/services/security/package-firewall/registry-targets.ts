/**
 * Which registry requests the package firewall inspects, and what each one is.
 *
 * Artifact downloads (npm tarballs, Python distributions, crates) map to the
 * package version they fetch, so a listed package fails at the download that
 * would have delivered its code. Package metadata (npm packuments, PyPI simple
 * indexes, the sparse crates index) maps to the package it describes, so the
 * firewall can leave out versions too recent to install (`release-age.ts`).
 */

/** OSV ecosystem names (https://ossf.github.io/osv-schema/#affectedpackage-field). */
export type PackageEcosystem = 'npm' | 'PyPI' | 'crates.io'

export interface PackageCoordinates {
  ecosystem: PackageEcosystem
  name: string
  /** Null when the URL names the package but not a parseable version. */
  version: string | null
}

/**
 * Hosts whose TLS the firewall terminates. The firewall CA's name constraints
 * are built from this list, so the CA cannot sign for anything else.
 */
export const INTERCEPTED_REGISTRY_HOSTS: ReadonlyMap<string, PackageEcosystem> = new Map([
  ['registry.npmjs.org', 'npm'],
  ['registry.yarnpkg.com', 'npm'],
  ['pypi.org', 'PyPI'],
  ['files.pythonhosted.org', 'PyPI'],
  ['index.crates.io', 'crates.io'],
  ['static.crates.io', 'crates.io'],
  ['crates.io', 'crates.io'],
])

export function interceptedEcosystem(host: string): PackageEcosystem | undefined {
  return INTERCEPTED_REGISTRY_HOSTS.get(host.toLowerCase())
}

/** Stable cache key for one package version. */
export function packageKey(pkg: PackageCoordinates): string {
  return `${pkg.ecosystem}:${pkg.name}@${pkg.version ?? '*'}`
}

/** `name@version` for messages. */
export function formatPackage(pkg: PackageCoordinates): string {
  return pkg.version === null ? pkg.name : `${pkg.name}@${pkg.version}`
}

/** PEP 503 normalisation: lowercase, runs of `-`, `_` and `.` become one `-`. */
export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

const VERSION_RE = /^[0-9][0-9A-Za-z.+!_-]*$/

function decodedPathname(path: string): string | null {
  const pathname = path.split(/[?#]/, 1)[0] ?? ''
  try {
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

/** `/<name>/-/<basename>-<version>.tgz`, scoped names included. */
function npmTarball(pathname: string): PackageCoordinates | null {
  const match = /^\/((?:@[^/]+\/)?[^/@][^/]*)\/-\/([^/]+)\.tgz$/.exec(pathname)
  if (!match) return null
  const name = match[1] ?? ''
  const file = match[2] ?? ''
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  const version = file.startsWith(`${unscoped}-`) ? file.slice(unscoped.length + 1) : ''
  return { ecosystem: 'npm', name, version: VERSION_RE.test(version) ? version : null }
}

const SDIST_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.zip', '.tar']

/** Name and version from a wheel, egg or sdist filename. */
export function pythonDistribution(filename: string): PackageCoordinates | null {
  let name: string | undefined
  let version: string | undefined
  if (filename.endsWith('.whl') || filename.endsWith('.egg')) {
    // {name}-{version}(-{build})?-{python}-{abi}-{platform}.whl; {name}-{version}-{py}.egg
    const parts = filename.slice(0, -4).split('-')
    name = parts[0]
    version = parts[1]
  } else {
    const suffix = SDIST_SUFFIXES.find((candidate) => filename.toLowerCase().endsWith(candidate))
    if (!suffix) return null
    const stem = filename.slice(0, -suffix.length)
    const split = stem.lastIndexOf('-')
    if (split <= 0) return null
    name = stem.slice(0, split)
    version = stem.slice(split + 1)
  }
  if (!name || !version) return null
  return {
    ecosystem: 'PyPI',
    name: normalizePythonName(name),
    version: VERSION_RE.test(version) ? version : null,
  }
}

/** `/packages/…/<filename>` on files.pythonhosted.org. */
function pythonFile(pathname: string): PackageCoordinates | null {
  if (!pathname.startsWith('/packages/')) return null
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1)
  return pythonDistribution(filename)
}

/**
 * `/crates/<name>/<name>-<version>.crate` and `/crates/<name>/<version>/download`
 * on static.crates.io; `/api/v1/crates/<name>/<version>/download` on crates.io.
 */
function crateDownload(host: string, pathname: string): PackageCoordinates | null {
  const download =
    host === 'crates.io'
      ? /^\/api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/.exec(pathname)
      : /^\/crates\/([^/]+)\/([^/]+)\/download$/.exec(pathname)
  let name = download?.[1]
  let version = download?.[2]
  const file = host === 'crates.io' ? null : /^\/crates\/([^/]+)\/([^/]+)\.crate$/.exec(pathname)
  if (file?.[1] && file[2]?.startsWith(`${file[1]}-`)) {
    name = file[1]
    version = file[2].slice(file[1].length + 1)
  }
  if (!name || !version) return null
  return {
    ecosystem: 'crates.io',
    name,
    version: VERSION_RE.test(version) ? version : null,
  }
}

/** The package version a registry request downloads, or null for metadata and anything else. */
export function packageForDownload(host: string, path: string): PackageCoordinates | null {
  const pathname = decodedPathname(path)
  if (pathname === null) return null
  switch (host.toLowerCase()) {
    case 'registry.npmjs.org':
    case 'registry.yarnpkg.com':
      return npmTarball(pathname)
    case 'files.pythonhosted.org':
      return pythonFile(pathname)
    case 'static.crates.io':
      return crateDownload('static.crates.io', pathname)
    case 'crates.io':
      return crateDownload('crates.io', pathname)
    default:
      return null
  }
}

/** The package whose version list a registry metadata request returns. */
export interface MetadataTarget {
  ecosystem: PackageEcosystem
  name: string
}

/** `/<name>` or `/@scope/<name>` (the slash usually encoded as `%2f`), never a `/-/` endpoint. */
function npmPackument(pathname: string): MetadataTarget | null {
  const match = /^\/((?:@[^/@]+\/)?[^/@][^/]*)$/.exec(pathname)
  const name = match?.[1]
  if (!name || name.startsWith('-')) return null
  return { ecosystem: 'npm', name }
}

/** `/simple/<name>/` on pypi.org (PEP 503 / PEP 691). */
function pythonSimpleIndex(pathname: string): MetadataTarget | null {
  const match = /^\/simple\/([^/]+)\/?$/.exec(pathname)
  return match?.[1] ? { ecosystem: 'PyPI', name: normalizePythonName(match[1]) } : null
}

/** `/1/<name>`, `/2/<name>`, `/3/<c>/<name>` and `/<ab>/<cd>/<name>` on index.crates.io. */
function cratesIndexFile(pathname: string): MetadataTarget | null {
  const match = /^\/(?:[12]|3\/[^/]|[^/]{2}\/[^/]{2})\/([^/]+)$/.exec(pathname)
  const name = match?.[1]
  return name && name !== 'config.json' ? { ecosystem: 'crates.io', name } : null
}

/** The package a registry metadata request describes, or null for downloads and anything else. */
export function metadataForRequest(host: string, path: string): MetadataTarget | null {
  const pathname = decodedPathname(path)
  if (pathname === null) return null
  switch (host.toLowerCase()) {
    case 'registry.npmjs.org':
    case 'registry.yarnpkg.com':
      return npmPackument(pathname)
    case 'pypi.org':
      return pythonSimpleIndex(pathname)
    case 'index.crates.io':
      return cratesIndexFile(pathname)
    default:
      return null
  }
}
