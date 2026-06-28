import { runCommand } from './command-runner.ts'
import { getBundledCodesearchPath } from './bundled-semantic.ts'
import { probeIndexedGrepBackends } from './indexed-grep.ts'
import { getCodesearchCommand, probeSemanticBackends } from './semantic-index.ts'

let rgAvail: boolean | null = null
let gitAvail: boolean | null = null
let ghAvail: boolean | null = null

export async function checkToolAvailability(): Promise<void> {
  // The e2e app relaunches Electron once per spec (~47×/full run); these probes
  // run before the window opens on every launch. Under e2e, skip them: ripgrep
  // and git are provisioned in the e2e environment, so assume them present (the
  // git-changes and search specs rely on it), while gh and the indexed-grep /
  // semantic-backend probes (a spawned codesearch binary) are unused by the
  // seeded suite, so leave them off rather than spawning anything.
  if (process.env['COPSE_E2E'] === '1') {
    rgAvail = true
    gitAvail = true
    ghAvail = false
    return
  }
  rgAvail = await probe('rg', ['--version'])
  gitAvail = await probe('git', ['--version'])
  ghAvail = await probe('gh', ['--version'])
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
  if (!ghAvail) console.warn('[copse-panel] gh not found — GitHub PR tools will be unavailable')
}

export const isRgAvailable = () => rgAvail === true
export const isGitAvailable = () => gitAvail === true
export const isGhAvailable = () => ghAvail === true

/** Test hook — force ripgrep availability without probing PATH. */
export function setRgAvailableForTest(value: boolean | null): void {
  rgAvail = value
}

/** Test hook — force git availability without probing PATH. */
export function setGitAvailableForTest(value: boolean | null): void {
  gitAvail = value
}

/** Test hook — force gh availability without probing PATH. */
export function setGhAvailableForTest(value: boolean | null): void {
  ghAvail = value
}

function probePathPrefix(): string {
  return process.platform === 'win32' ? '' : '/usr/bin:/bin:/exec-daemon:'
}

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(cmd, args, {
      env: { PATH: `${probePathPrefix()}${process.env['PATH'] ?? ''}` },
    })
    return true
  } catch {
    return false
  }
}
