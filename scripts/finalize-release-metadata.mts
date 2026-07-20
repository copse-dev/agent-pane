import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPublishedUpdateChannels, getUpdateChannel } from '../src/shared/release-channel.mts'

function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error('package.json must contain a string version')
  }
  return parsed.version
}

function main(): void {
  const [version = packageVersion(), outputDirectory = 'release', ...extra] = process.argv.slice(2)
  if (extra.length > 0) {
    throw new Error(
      'Usage: node scripts/finalize-release-metadata.mts [version] [output-directory]',
    )
  }

  const sourceChannel = getUpdateChannel(version)
  const source = join(outputDirectory, `${sourceChannel}-mac.yml`)
  if (!existsSync(source)) {
    throw new Error(`Expected update metadata was not generated: ${source}`)
  }

  for (const channel of getPublishedUpdateChannels(version)) {
    const destination = join(outputDirectory, `${channel}-mac.yml`)
    if (destination !== source) copyFileSync(source, destination)
    console.log(destination)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
