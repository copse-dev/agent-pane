import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { getPublishedUpdateChannels, getUpdateChannel } from '../src/shared/release-channel.mts'

type Arch = 'arm64' | 'x64'
type PackageKind = 'dmg' | 'zip'

interface PackageFile {
  arch: Arch
  kind: PackageKind
  path: string
  name: string
  sha512: string
  size: number
}

function filesBelow(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...filesBelow(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function hashFile(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm)
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', resolvePromise)
  })
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sourceReleaseDate(
  metadataPaths: string[],
  version: string,
  packageNames: string[],
): string {
  if (metadataPaths.length !== 2) {
    throw new Error(
      `Expected one update metadata file per architecture, found ${String(metadataPaths.length)}`,
    )
  }

  const seenArchitectures = new Set<Arch>()
  const dates = metadataPaths.map((path) => {
    const nameMatch = basename(path).match(/-mac\.(arm64|x64)\.yml$/)
    const arch = nameMatch?.[1]
    if (arch !== 'arm64' && arch !== 'x64') {
      throw new Error(`Architecture metadata has an invalid name: ${path}`)
    }
    if (seenArchitectures.has(arch)) {
      throw new Error(`Duplicate ${arch} update metadata: ${path}`)
    }
    seenArchitectures.add(arch)
    const metadata = readFileSync(path, 'utf8')
    if (!metadata.includes(`version: ${version}\n`)) {
      throw new Error(`Update metadata has the wrong version: ${path}`)
    }
    const expectedPackages = packageNames.filter((name) => name.includes(`-${arch}.`))
    if (
      expectedPackages.length !== 2 ||
      !expectedPackages.every((name) => metadata.includes(`url: ${name}`))
    ) {
      throw new Error(`Expected the ${arch} zip and dmg in update metadata: ${path}`)
    }
    const match = metadata.match(/^releaseDate: ['"]?([^'"\n]+)['"]?$/m)
    if (!match?.[1] || Number.isNaN(Date.parse(match[1]))) {
      throw new Error(`Update metadata has no valid releaseDate: ${path}`)
    }
    return match[1]
  })
  return dates.sort().at(-1) ?? ''
}

function renderMetadata(version: string, packages: PackageFile[], releaseDate: string): string {
  const ordered = [...packages].sort((left, right) => {
    const kindOrder = left.kind === right.kind ? 0 : left.kind === 'zip' ? -1 : 1
    if (kindOrder !== 0) return kindOrder
    return left.arch === right.arch ? 0 : left.arch === 'x64' ? -1 : 1
  })
  const primary = ordered.find((file) => file.kind === 'zip' && file.arch === 'x64')
  if (!primary) throw new Error('Expected an x64 zip for legacy update metadata fields')

  return [
    `version: ${version}`,
    'files:',
    ...ordered.flatMap((file) => [
      `  - url: ${file.name}`,
      `    sha512: ${file.sha512}`,
      `    size: ${String(file.size)}`,
    ]),
    `path: ${primary.name}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

export async function assembleMacosRelease(
  version: string,
  inputRoot: string,
  outputDirectory: string,
): Promise<void> {
  const updateChannel = getUpdateChannel(version)
  const allFiles = filesBelow(inputRoot)
  const escapedVersion = escapeRegExp(version)
  const packagePattern = new RegExp(`^Copse-${escapedVersion}-(arm64|x64)\\.(dmg|zip)$`)
  const blockmapPattern = new RegExp(`^Copse-${escapedVersion}-(arm64|x64)\\.(dmg|zip)\\.blockmap$`)
  const packageSources = allFiles.filter((path) => packagePattern.test(basename(path)))
  const blockmapSources = allFiles.filter((path) => blockmapPattern.test(basename(path)))
  const expectedCount = 2 * 2
  if (packageSources.length !== expectedCount || blockmapSources.length !== expectedCount) {
    throw new Error(
      `Expected ${String(expectedCount)} packages and ${String(expectedCount)} blockmaps; found ${String(packageSources.length)} and ${String(blockmapSources.length)}`,
    )
  }

  mkdirSync(outputDirectory, { recursive: true })
  const existingOutput = readdirSync(outputDirectory)
  if (existingOutput.length > 0) {
    throw new Error(`Release assembly output must be empty: ${outputDirectory}`)
  }
  const packages: PackageFile[] = []
  for (const source of packageSources) {
    const name = basename(source)
    const match = name.match(packagePattern)
    if (!match) throw new Error(`Unexpected package name: ${name}`)
    const arch = match[1]
    const kind = match[2]
    if ((arch !== 'arm64' && arch !== 'x64') || (kind !== 'dmg' && kind !== 'zip')) {
      throw new Error(`Unsupported package target: ${name}`)
    }
    const destination = join(outputDirectory, name)
    copyFileSync(source, destination)
    packages.push({
      arch,
      kind,
      path: destination,
      name,
      sha512: await hashFile(destination, 'sha512'),
      size: statSync(destination).size,
    })
  }
  for (const source of blockmapSources)
    copyFileSync(source, join(outputDirectory, basename(source)))

  const sourceMetadataPattern = new RegExp(`^${updateChannel}-mac\\.(?:arm64|x64)\\.yml$`)
  const sourceMetadata = allFiles.filter((path) => sourceMetadataPattern.test(basename(path)))
  const releaseDate = sourceReleaseDate(
    sourceMetadata,
    version,
    packages.map((file) => file.name),
  )
  const metadata = renderMetadata(version, packages, releaseDate)
  for (const channel of getPublishedUpdateChannels(version)) {
    writeFileSync(join(outputDirectory, `${channel}-mac.yml`), metadata)
  }

  const checksumNames = readdirSync(outputDirectory)
    .filter((name) => /\.(?:dmg|zip|blockmap|yml)$/.test(name))
    .sort()
  const checksums: string[] = []
  for (const name of checksumNames) {
    checksums.push(`${await hashFile(join(outputDirectory, name), 'sha256')}  ${name}`)
  }
  writeFileSync(join(outputDirectory, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
}

async function main(): Promise<void> {
  const [version, inputRoot = 'staged-release', outputDirectory = 'release', ...extra] =
    process.argv.slice(2)
  if (!version || extra.length > 0) {
    throw new Error(
      'Usage: node scripts/assemble-macos-release.mts <version> [input-root] [output-directory]',
    )
  }
  await assembleMacosRelease(version, resolve(inputRoot), resolve(outputDirectory))
}

if (basename(process.argv[1] ?? '') === 'assemble-macos-release.mts') {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
