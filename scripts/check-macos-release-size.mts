import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const MAX_INSTALLER_BYTES = 230 * 1024 * 1024
export const MAX_APP_BYTES = 750 * 1024 * 1024

export interface SizeMeasurement {
  name: string
  bytes: number
  limit: number
}

function directoryBytes(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += directoryBytes(child)
    else if (entry.isFile()) total += statSync(child).size
  }
  return total
}

export function assertReleaseSizes(measurements: SizeMeasurement[]): void {
  const oversized = measurements.filter((measurement) => measurement.bytes > measurement.limit)
  if (oversized.length > 0) {
    throw new Error(
      `Release size budget exceeded: ${oversized
        .map(
          ({ name, bytes, limit }) =>
            `${name} ${(bytes / 1024 / 1024).toFixed(1)} MiB > ${(limit / 1024 / 1024).toFixed(1)} MiB`,
        )
        .join(', ')}`,
    )
  }
}

function findAppBundles(root: string): string[] {
  const bundles: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && entry.name.endsWith('.app')) bundles.push(path)
    else if (entry.isDirectory()) bundles.push(...findAppBundles(path))
  }
  return bundles
}

export function measureRelease(root: string, arch: 'arm64' | 'x64'): SizeMeasurement[] {
  const packagePattern = new RegExp(`-${arch}\\.(?:dmg|zip)$`)
  const installers = readdirSync(root)
    .filter((name) => packagePattern.test(name))
    .sort()
    .map((name) => ({ name, bytes: statSync(join(root, name)).size, limit: MAX_INSTALLER_BYTES }))
  const apps = findAppBundles(root).filter((path) => {
    const parent = basename(resolve(path, '..'))
    return parent === `mac-${arch}` || (arch === 'x64' && parent === 'mac')
  })
  if (installers.length !== 2 || apps.length !== 1) {
    throw new Error(
      `Expected two ${arch} installers and one app bundle; found ${String(installers.length)} and ${String(apps.length)}`,
    )
  }
  return [
    ...installers,
    {
      name: `${basename(apps[0] ?? '')} (${arch}, installed)`,
      bytes: directoryBytes(apps[0] ?? ''),
      limit: MAX_APP_BYTES,
    },
  ]
}

function markdown(measurements: SizeMeasurement[]): string {
  return [
    '| Release payload | Size | Budget |',
    '| --- | ---: | ---: |',
    ...measurements.map(
      ({ name, bytes, limit }) =>
        `| ${name} | ${(bytes / 1024 / 1024).toFixed(1)} MiB | ${(limit / 1024 / 1024).toFixed(0)} MiB |`,
    ),
    '',
  ].join('\n')
}

function main(): void {
  const [root = 'release', arch, ...extra] = process.argv.slice(2)
  if ((arch !== 'arm64' && arch !== 'x64') || extra.length > 0) {
    throw new Error(
      'Usage: node scripts/check-macos-release-size.mts [release-directory] <arm64|x64>',
    )
  }
  const measurements = measureRelease(resolve(root), arch)
  const report = markdown(measurements)
  process.stdout.write(report)
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) appendFileSync(summary, `## macOS ${arch} release size\n\n${report}`)
  assertReleaseSizes(measurements)
}

if (basename(process.argv[1] ?? '') === 'check-macos-release-size.mts') {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
