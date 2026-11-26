import { parse as parseShell } from 'shell-quote'
import { commandName } from './shell-argv.ts'

/**
 * Whether every `curl`/`wget` in a command is a request to this machine's
 * loopback interface: `curl -s http://localhost:3000/api/rides`.
 *
 * This decides only where such a command is tried first. A loopback request
 * runs inside the project sandbox, whose seatbelt allows connecting to a port
 * only when the thread's own background task is listening on it; any other
 * destination is still blocked there and offered as an outside-sandbox retry.
 * So the check fails closed in the cheap direction: anything it cannot read
 * (substitution, a wrapper such as `xargs curl`, a URL in a variable, a bare
 * host name) keeps the up-front prompt.
 */
const DOWNLOADERS: ReadonlySet<string> = new Set(['curl', 'wget'])

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/** `http(s)://host[:port]…`, capturing the host. Userinfo is refused outright. */
const HTTP_URL = /^https?:\/\/([^/?#@]+?)(?::\d{1,5})?(?:[/?#]|$)/i

/**
 * Whether one downloader argv names at least one URL and only loopback ones.
 * A bare host (`curl example.com`) is not looked for: it is no URL, so a
 * command naming nothing else keeps its prompt, and one that also names a
 * loopback URL is still blocked from that host by the sandbox.
 */
function argvTargetsOnlyLoopback(argv: readonly string[]): boolean {
  let urls = 0
  for (const word of argv.slice(1)) {
    const value =
      word.startsWith('--') && word.includes('=') ? word.slice(word.indexOf('=') + 1) : word
    if (!/^[a-z][\w+.-]*:\/\//i.test(value)) continue
    const host = HTTP_URL.exec(value)?.[1]
    if (host === undefined || !LOOPBACK_HOST.test(host)) return false
    urls++
  }
  return urls > 0
}

/**
 * Unquoted newlines as `;`, so each line is its own segment: shell-quote reads
 * a newline as plain whitespace, which would merge `echo …` and the `curl` on
 * the next line into one argv.
 */
function newlinesAsSeparators(command: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i)
    if (quote === null && char === '\\') {
      out += char + command.charAt(i + 1)
      i++
      continue
    }
    if (quote === null && (char === '"' || char === "'")) quote = char
    else if (quote !== null && char === quote) quote = null
    else if (quote === '"' && char === '\\') {
      out += char + command.charAt(i + 1)
      i++
      continue
    }
    out += quote === null && char === '\n' ? ' ; ' : char
  }
  return out
}

/**
 * Plain assignments on a line of their own (`BASE=http://localhost:3000`), so
 * `curl "$BASE/api"` on a later line reads the URL it really requests. Only a
 * literal value counts: one holding `$`, a quote or a backslash is unknown, and
 * an unknown variable expands to nothing, which names no URL.
 */
function literalAssignments(command: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of command.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)=([^\s$`'"\\;&|<>()]*)\s*$/.exec(line)
    if (match?.[1] !== undefined) values.set(match[1], match[2] ?? '')
  }
  return values
}

export function requestsOnlyLoopback(command: string): boolean {
  if (/`|\$\(|[<>]\(/.test(command)) return false
  const assigned = literalAssignments(command)
  let tokens: ReturnType<typeof parseShell>
  try {
    tokens = parseShell(newlinesAsSeparators(command), (name) => assigned.get(name) ?? '')
  } catch {
    return false
  }
  let argv: string[] = []
  let downloaders = 0
  let wordsNamingDownloader = 0
  const segments: string[][] = []
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (/\b(?:curl|wget)\b/i.test(token)) wordsNamingDownloader++
      argv.push(token)
      continue
    }
    if (!('op' in token) || token.op === 'glob') return false
    segments.push(argv)
    argv = []
  }
  segments.push(argv)
  for (const segment of segments) {
    if (!DOWNLOADERS.has(commandName(segment[0]))) continue
    downloaders++
    if (!argvTargetsOnlyLoopback(segment)) return false
  }
  // Every word naming a downloader must be one of the heads checked above;
  // otherwise one runs in a form this walk did not read (`xargs curl`,
  // `timeout 5 curl`, `env curl`), or the name is only text (`echo curl`).
  return downloaders > 0 && wordsNamingDownloader === downloaders
}
