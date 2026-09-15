import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnInProjectSandbox } from '../../project-sandbox/spawn.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'

export async function containedPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const canonical = await realpath(resolve(root, path))
  const rel = relative(canonicalRoot, canonical)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
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
  const append = (chunk: Buffer, error: boolean): void => {
    const text = chunk.toString('utf8')
    if (error) errorOutput = (errorOutput + text).slice(-32_000)
    else output = (output + text).slice(-2_000_000)
    options.log?.(text)
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    append(chunk, false)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    append(chunk, true)
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
