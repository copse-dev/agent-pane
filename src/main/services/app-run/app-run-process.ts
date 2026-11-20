import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isPathWithin } from '@copse/std/path-containment.ts'
import { spawnInProjectSandbox } from '../../project-sandbox/spawn.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'

export async function containedPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const canonical = await realpath(resolve(root, path))
  if (!isPathWithin(canonicalRoot, canonical)) {
    throw new Error('The selected app path is outside this checkout.')
  }
  return canonical
}

/** Host execution is authorized by the explicit Run/setup IPC, never by discovery from an agent. */
export async function runAppProcess(
  executable: string,
  args: readonly string[],
  root: string,
  signal: AbortSignal,
  options: {
    env?: NodeJS.ProcessEnv
    log?: (text: string) => void
    input?: string
    timeoutMs?: number
  } = {},
): Promise<string> {
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000)
  const combined = AbortSignal.any([signal, timeout])
  const child = await spawnInProjectSandbox(executable, [...args], {
    cwd: root,
    ...(options.env ? { env: options.env } : {}),
    stdio: 'pipe',
    unsandboxed: true,
  })
  let output = ''
  let errorOutput = ''
  const append = (text: string, error: boolean): void => {
    if (!text) return
    if (error) errorOutput = (errorOutput + text).slice(-32_000)
    else output = (output + text).slice(-2_000_000)
    options.log?.(text)
  }
  // Decode across chunk boundaries: build tools print non-ASCII names and
  // punctuation, and a pipe read can end mid-character.
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  child.stdout?.on('data', (chunk: Buffer) => {
    append(stdoutDecoder.write(chunk), false)
  })
  child.stdout?.once('end', () => {
    append(stdoutDecoder.end(), false)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    append(stderrDecoder.write(chunk), true)
  })
  child.stderr?.once('end', () => {
    append(stderrDecoder.end(), true)
  })
  child.stdin?.end(options.input ?? '')
  let stopKill: (() => void) | undefined
  const abort = (): void => {
    stopKill = terminateProcessTree(child)
  }
  combined.addEventListener('abort', abort, { once: true })
  if (combined.aborted) abort()
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', resolveExit)
    })
    combined.throwIfAborted()
    if (code !== 0) {
      throw new Error(
        (errorOutput.trim() || output.trim() || `Command exited with code ${String(code)}.`).slice(
          -8000,
        ),
      )
    }
    return output
  } finally {
    combined.removeEventListener('abort', abort)
    stopKill?.()
  }
}
