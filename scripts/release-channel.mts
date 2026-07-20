import { readFileSync } from 'node:fs'
import { getGitHubReleaseType, getUpdateChannel } from '../src/shared/release-channel.mts'

type OutputField = 'channel' | 'release-type'

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

function parseArgs(args: string[]): { field: OutputField; version: string } {
  let field: OutputField = 'release-type'
  let version: string | undefined

  for (const arg of args) {
    if (arg === '--channel') {
      field = 'channel'
    } else if (arg === '--release-type') {
      field = 'release-type'
    } else if (version === undefined) {
      version = arg
    } else {
      throw new Error(
        'Usage: node scripts/release-channel.mts [--channel|--release-type] [version]',
      )
    }
  }

  return { field, version: version ?? packageVersion() }
}

function main(): void {
  const { field, version } = parseArgs(process.argv.slice(2))
  console.log(field === 'channel' ? getUpdateChannel(version) : getGitHubReleaseType(version))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
