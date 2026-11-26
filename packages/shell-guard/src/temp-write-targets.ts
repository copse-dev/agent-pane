import { analyzeShellCommand, dangerousInSandboxReasons } from './shell-scope.ts'

/**
 * The `/tmp` paths a command names, when they are the only thing that forces
 * it out of the project sandbox: `curl -c /tmp/cookies.txt
 * http://localhost:3000/api/me`, `node src/server.js > /tmp/server.log`.
 *
 * Such a command can stay contained with exactly those paths writable, which
 * is narrower than the outside-sandbox run it otherwise needs: no network, no
 * other path. Returns null when any `/tmp` mention is not a plain literal path
 * (a variable, glob, `..`, or `/tmp` itself), when the command would still
 * leave the sandbox with those paths set aside, or when it is destructive.
 *
 * The seatbelt enforces against the resolved path, so a name under `/tmp`
 * that is a symlink elsewhere still cannot write its target.
 */
const TMP_MENTION = /(?:\/private)?\/tmp(?![\w.-])/g

/** A literal path under /tmp, at a word boundary, up to a shell separator. */
const TMP_PATH = /(^|[\s'"=:(|;&<>])((?:\/private)?\/tmp\/[^\s'"|;&<>()]*)/g

const LITERAL_TMP_PATH = /^(?:\/private)?\/tmp\/[\w.@%+,-]+(?:\/[\w.@%+,-]+)*\/?$/

export function tempWriteTargets(command: string, workspaceRoot: string | null): string[] | null {
  if (workspaceRoot === null) return null
  const mentions = command.match(TMP_MENTION)?.length ?? 0
  if (mentions === 0) return null
  const paths: string[] = []
  let placeholder = 0
  const contained = command.replace(TMP_PATH, (_match, lead: string, path: string) => {
    paths.push(path)
    placeholder++
    return `${lead}copse-temp-${String(placeholder)}`
  })
  // Every mention must be one of the literal paths just replaced.
  if (paths.length !== mentions) return null
  if (
    paths.some(
      (path) => !LITERAL_TMP_PATH.test(path) || path.split('/').some((part) => /^\.+$/.test(part)),
    )
  )
    return null
  if (dangerousInSandboxReasons(command).length > 0) return null
  if (analyzeShellCommand(contained, workspaceRoot).verdict === 'external') return null
  return [...new Set(paths.map((path) => path.replace(/\/$/, '')))]
}
