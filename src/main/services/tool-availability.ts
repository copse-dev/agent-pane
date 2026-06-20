import { runCommand } from './command-runner.ts'
import { probeIndexedGrepBackends } from './indexed-grep.ts'

let rgAvail: boolean | null = null
let gitAvail: boolean | null = null

export async function checkToolAvailability(): Promise<void> {
  rgAvail = await probe('rg', ['--version'])
  gitAvail = await probe('git', ['--version'])
  const grepBackend = await probeIndexedGrepBackends()
  if (!rgAvail)
    console.warn('[agent-pane] ripgrep (rg) not found — search_code will use slow fallback')
  else if (grepBackend !== 'rg')
    console.info(`[agent-pane] search_code will prefer indexed grep backend: ${grepBackend}`)
  if (!gitAvail) console.warn('[agent-pane] git not found — git tools will be unavailable')
}

export const isRgAvailable = () => rgAvail === true
export const isGitAvailable = () => gitAvail === true

/** Test hook — force ripgrep availability without probing PATH. */
export function setRgAvailableForTest(value: boolean | null): void {
  rgAvail = value
}

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(cmd, args)
    return true
  } catch {
    return false
  }
}
