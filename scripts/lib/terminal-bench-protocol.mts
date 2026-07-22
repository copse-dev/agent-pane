export interface TerminalToolResult {
  type: 'tool_result'
  id: string
  exitCode: number
  stdout: string
  stderr: string
}

export function formatTerminalResult(result: TerminalToolResult): string {
  const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : ''
  const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : ''
  return `exit=${String(result.exitCode)}${stdout}${stderr}`
}
