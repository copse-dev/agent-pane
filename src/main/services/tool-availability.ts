import { runCommand } from './command-runner.ts'
import { getBundledCodesearchPath } from './bundled-semantic.ts'
import { probeIndexedGrepBackends } from './indexed-grep.ts'
import { getCodesearchCommand, probeSemanticBackends } from './semantic-index.ts'

let rgAvail: boolean | null = null
let gitAvail: boolean | null = null

export async function checkToolAvailability(): Promise<void> {
  rgAvail = await probe('rg', ['--version'])
  gitAvail = await probe('git', ['--version'])
  const grepBackend = await probeIndexedGrepBackends()
  const semanticBackend = await probeSemanticBackends()
  if (!rgAvail)
    console.warn('[copse-panel] ripgrep (rg) not found — search_code will use slow fallback')
  else if (grepBackend !== 'rg')
    console.info(`[copse-panel] search_code will prefer indexed grep backend: ${grepBackend}`)
  if (semanticBackend)
    console.info(
      `[copse-panel] semantic search will use native backend: ${semanticBackend}` +
        (getCodesearchCommand() === getBundledCodesearchPath() ? ' (bundled)' : ''),
    )
  else
    console.warn(
      '[copse-panel] codesearch/vera not found — semantic search disabled (run npm install or add CLI to PATH)',
    )
  if (!gitAvail) console.warn('[copse-panel] git not found — git tools will be unavailable')
}

export const isRgAvailable = () => rgAvail === true
export const isGitAvailable = () => gitAvail === true

/** Test hook — force ripgrep availability without probing PATH. */
export function setRgAvailableForTest(value: boolean | null): void {
  rgAvail = value
}

/** Test hook — force git availability without probing PATH. */
export function setGitAvailableForTest(value: boolean | null): void {
  gitAvail = value
}

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    const pathPrefix = process.platform === 'win32' ? '' : '/usr/bin:/bin:'
    await runCommand(cmd, args, {
      env: { PATH: `${pathPrefix}${process.env.PATH ?? ''}` },
    })
    return true
  } catch {
    return false
  }
}
