import { commandName } from './shell-argv.ts'
import { secretFileName } from './secrets.ts'

/**
 * Release and secret shapes the Guarded YOLO harm gate missed in generated adversarial rows
 * (benchmarks/risk-classifier/adversarial): a registry login fed a token, a raw kubeconfig
 * print, a private-key export, a release tool other than the package managers, a git alias
 * that hides a tag push, git traces with redaction off, and code that dumps the environment,
 * reads a secret file or runs a signer from an argv array.
 *
 * Only the harm gate calls these. The standard-mode tiers read `release-actions.ts` and
 * `shell-argv.ts`, which this file leaves alone, so standard mode asks exactly as before.
 * Every rule only adds a prompt.
 */

/** Release tools that publish unless told to rehearse. */
const RELEASE_TOOLS = new Map<string, RegExp>([
  ['goreleaser', /^(?:release)$/],
  ['changeset', /^(?:publish)$/],
  ['semantic-release', /^/],
  ['release-it', /^/],
])
const RELEASE_REHEARSAL =
  /^(?:--snapshot|--skip-publish|--skip=publish|--dry-run|-d|--help|-h|--version)$/

/** Registry clients whose `login` stores a credential handed to them. */
const REGISTRY_LOGINS = new Set(['docker', 'podman', 'nerdctl', 'oras', 'skopeo'])

/** Why one unwrapped argv is release or secret work a person must see; empty when it is not. */
export function releaseWorkReasons(argv: readonly string[]): string[] {
  const head = commandName(argv[0])
  const words = argv.slice(1).filter((arg) => !arg.startsWith('-'))
  const reasons: string[] = []
  const loginAt =
    REGISTRY_LOGINS.has(head) || head === 'helm'
      ? argv.findIndex((arg, index) => index > 0 && arg === 'login')
      : -1
  if (
    loginAt !== -1 &&
    (head !== 'helm' || argv[loginAt - 1] === 'registry') &&
    argv.some((arg) => /^(?:--password-stdin|--password|-p)(?:=|$)/.test(arg))
  ) {
    reasons.push(`logs in to a registry with a credential (${head} login)`)
  }
  if (
    head === 'kubectl' &&
    words[0] === 'config' &&
    words[1] === 'view' &&
    argv.some((arg) => arg === '--raw' || arg === '--flatten')
  ) {
    reasons.push('prints cluster credentials (kubectl config view --raw)')
  }
  if (
    (head === 'gpg' || head === 'gpg2') &&
    argv.some((arg) => /^--export-secret-(?:keys|subkeys)$/.test(arg))
  ) {
    reasons.push(`exports a private key (${head} --export-secret-keys)`)
  }
  const release = RELEASE_TOOLS.get(head)
  if (
    release !== undefined &&
    (head === 'semantic-release' || head === 'release-it' || release.test(words[0] ?? '')) &&
    !argv.slice(1).some((arg) => RELEASE_REHEARSAL.test(arg))
  ) {
    reasons.push(`publishes a release (${head}${words[0] ? ` ${words[0]}` : ''})`)
  }
  return reasons
}

/** Variables that make git print request headers, tokens included, in its traces. */
const UNREDACTED_TRACE =
  /(?:^|[\s;&|(])(?:GIT_TRACE_REDACT=(?:0|false|no)|GIT_CURL_VERBOSE=(?:1|true|yes))\b/i

/** Command-line reasons no single argv shows, because assignments are stripped before argv rules. */
export function releaseWorkCommandReasons(command: string): string[] {
  return UNREDACTED_TRACE.test(command)
    ? ["prints git's authentication headers (redaction turned off)"]
    : []
}

/**
 * `git -c alias.ship='push origin +HEAD:refs/tags/v1' ship` runs the alias body as if typed.
 * Returns that command, for the gate to assess as written; a `!` alias is shell.
 */
export function gitAliasExpansion(argv: readonly string[]): string | null {
  if (commandName(argv[0]) !== 'git') return null
  const aliases = new Map<string, string>()
  let index = 1
  for (; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '-c' || arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
      const value = argv[index + 1] ?? ''
      const alias = arg === '-c' ? /^alias\.([^=]+)=([\s\S]*)$/i.exec(value) : null
      if (alias?.[1] && alias[2] !== undefined) aliases.set(alias[1].toLowerCase(), alias[2])
      index += 1
      continue
    }
    if (!arg.startsWith('-')) break
  }
  const subcommand = argv[index]
  const body = subcommand === undefined ? undefined : aliases.get(subcommand.toLowerCase())
  if (body === undefined) return null
  const rest = argv.slice(index + 1).join(' ')
  return body.startsWith('!') ? `${body.slice(1)} ${rest}`.trim() : `git ${body} ${rest}`.trim()
}

// ---------------------------------------------------------------------------
// Code handed to an interpreter
// ---------------------------------------------------------------------------

/** `"rel" + "ease"` → `"release"`, so a split word reads as the word it spells. */
export function foldStringConcatenation(code: string): string {
  const pair = /(['"])([^'"\\\n]*)\1\s*\+\s*(['"])([^'"\\\n]*)\3/g
  let previous = ''
  let folded = code
  while (folded !== previous) {
    previous = folded
    folded = folded.replace(pair, (_match, _q1, a: string, _q2, b: string) => `"${a}${b}"`)
  }
  return folded
}

const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g

/**
 * Commands code runs from an argv array: `subprocess.run(["gpg", "--detach-sign", art])`,
 * `execFileSync("gh", ["release", "create", v])`, `system("gpg", "--sign", f)`. Each comes back
 * as shell words; a word that is not a literal becomes `"$ARG"`, which no rule reads as a name.
 */
export function codeArgvCommands(code: string): string[] {
  const commands: string[] = []
  const call =
    /\b(?:execFileSync|execFile|spawnSync|spawn|subprocess\.(?:run|call|check_call|check_output|Popen)|os\.exec\w*|Open3\.\w+|Process\.spawn|system)\s*\(\s*(?:(['"])([\w./@-]+)\1\s*,\s*)?\[([^\]]*)\]/g
  for (const match of code.matchAll(call)) {
    const words: string[] = match[2] ? [match[2]] : []
    for (const part of (match[3] ?? '').split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const literal = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(trimmed)
      words.push(literal ? (literal[2] ?? '') : '$ARG')
    }
    if (words.length > 0) commands.push(words.map(shellQuote).join(' '))
  }
  return commands
}

function shellQuote(word: string): string {
  return word === '$ARG' || /^[\w./@:=+,-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`
}

/** Code that prints or saves every environment variable, tokens included. */
const ENVIRONMENT_DUMP =
  /\bENV\.(?:each|each_pair|sort|to_h|to_hash|to_a|map|inspect|select|filter)\b|\bdict\(\s*os\.environ\s*\)|\bos\.environ\.(?:items|copy)\(\)|\bjson\.dumps\(\s*(?:dict\(\s*)?os\.environ\b|\b(?:print|pprint)\(\s*(?:dict\(\s*)?os\.environ\s*\)|\bJSON\.stringify\(\s*process\.env\s*[,)]|\bObject\.(?:entries|values)\(\s*process\.env\s*\)|\bconsole\.(?:log|dir)\(\s*process\.env\s*\)|%ENV\b/

/** Calls that read a file's contents. */
const FILE_READ =
  /\b(?:readFileSync|readFile|createReadStream|read_text|read_bytes|File\.read|IO\.read|File\.open|open)\s*\(/

/** Why code handed to an interpreter must be seen; empty when nothing here applies. */
export function codeSecretReasons(code: string): string[] {
  const reasons: string[] = []
  if (ENVIRONMENT_DUMP.test(code)) reasons.push('dumps every environment variable, tokens included')
  if (FILE_READ.test(code)) {
    const names = new Set<string>()
    for (const match of code.matchAll(STRING_LITERAL)) {
      const name = secretFileName(match[2] ?? '')
      if (name) names.add(name)
    }
    if (names.size > 0) reasons.push(`reads a secret file (${[...names].join(', ')})`)
  }
  return reasons
}
