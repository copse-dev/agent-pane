import { runCommand } from './command-runner.ts'

let rgAvail: boolean | null = null
let gitAvail: boolean | null = null

export async function checkToolAvailability(): Promise<void> {
  rgAvail = await probe('rg', ['--version'])
  gitAvail = await probe('git', ['--version'])
  if (!rgAvail)
    console.warn('[agent-pane] ripgrep (rg) not found — search_code will use slow fallback')
  if (!gitAvail) console.warn('[agent-pane] git not found — git tools will be unavailable')
}

export const isRgAvailable = () => rgAvail === true
export const isGitAvailable = () => gitAvail === true

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(cmd, args)
    return true
  } catch {
    return false
  }
}
