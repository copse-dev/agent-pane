import { basename } from 'node:path'
import { commandName } from './shell-argv.ts'

/**
 * Secrets a command can expose without touching a credential directory: a
 * project's own `.env`, a key file checked out next to the code, or a CLI whose
 * job is to print a token. Shared by the auto-approval read tier (which must not
 * approve reading them) and the Guarded YOLO harm gate (which asks once).
 */

/**
 * Basenames of files that hold secrets wherever they live, including inside the
 * workspace. Templates (`.env.example`, `.env.sample`, …) and public keys hold none.
 */
const SECRET_FILE =
  /^(?:\.env(?:\.(?!(?:example|sample|template|dist|defaults?|schema)$)[\w.-]+)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|env)|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(?:pem|key|p12|pfx|jks|keystore|ppk))$/i

/** Values a flag or `@file` form wraps a path in: `--env-file=.env`, `-d @.env`. */
function pathCandidates(token: string): string[] {
  const out = [token]
  const eq = token.indexOf('=')
  if (eq !== -1) out.push(token.slice(eq + 1))
  for (const value of [...out]) if (value.startsWith('@')) out.push(value.slice(1))
  return out
}

/** The secret file a token names, if any: `.env`, `./config/prod.env.local`, `@id_rsa`. */
function secretFileName(token: string): string | null {
  for (const candidate of pathCandidates(token)) {
    if (!candidate || candidate.includes('://')) continue
    const name = basename(candidate.replace(/[\\/]+$/, ''))
    if (SECRET_FILE.test(name)) return name
  }
  return null
}

/** Every secret file an argv names in an operand or a flag value. */
export function secretFilesIn(argv: readonly string[]): string[] {
  const found = new Set<string>()
  for (const token of argv.slice(1)) {
    const name = secretFileName(token)
    if (name) found.add(name)
  }
  return [...found]
}

/**
 * Programs that print, search, encode or send a file's contents. Other heads that
 * merely name a secret file (`docker run --env-file .env`, `source .env`) load it
 * without showing it, and the copy family writes one (`cp .env.example .env`).
 */
const CONTENT_EXPOSERS = new Set([
  'cat',
  'bat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'awk',
  'gawk',
  'sed',
  'cut',
  'sort',
  'uniq',
  'nl',
  'tac',
  'strings',
  'xxd',
  'od',
  'hexdump',
  'base64',
  'jq',
  'yq',
  'diff',
  'column',
  'paste',
  'openssl',
  'curl',
  'wget',
  'http',
  'xh',
  'nc',
  'ncat',
  'scp',
  'rsync',
  'tar',
  'zip',
  'gzip',
  'pbcopy',
])

/** Cluster and cloud commands that upload a file as a secret or config value. */
function uploadsFileToCluster(argv: readonly string[]): boolean {
  const head = commandName(argv[0])
  if (head !== 'kubectl' && head !== 'oc') return false
  return argv.some((arg) => /^--from-(?:env-)?file\b/.test(arg))
}

/** Why an argv exposes the contents of a secret file, if it does. */
export function secretFileExposure(argv: readonly string[]): string | null {
  const names = secretFilesIn(argv)
  if (names.length === 0) return null
  const head = commandName(argv[0])
  if (CONTENT_EXPOSERS.has(head) || uploadsFileToCluster(argv)) {
    return `exposes the contents of a secret file (${names.join(', ')})`
  }
  return null
}

/**
 * CLIs whose output is a token or a password. Each entry matches the words after
 * the program name, flags excluded.
 */
const TOKEN_PRINTERS: ReadonlyArray<{ head: string; words: RegExp; what: string }> = [
  { head: 'security', words: /^(?:dump-keychain|export)\b/, what: 'keychain contents' },
  {
    head: 'gcloud',
    words: /^auth (?:application-default )?print-\w+-token\b/,
    what: 'a Google Cloud token',
  },
  { head: 'az', words: /^account get-access-token\b/, what: 'an Azure token' },
  {
    head: 'aws',
    words:
      /^(?:configure (?:get|export-credentials)|sts (?:get-session-token|assume-role\S*)|ecr get-login-password|secretsmanager get-secret-value|ssm get-parameters?\b.*--with-decryption)\b/,
    what: 'AWS credentials',
  },
  { head: 'npm', words: /^token\b/, what: 'an npm token' },
  { head: 'heroku', words: /^auth:token\b/, what: 'a Heroku token' },
  { head: 'op', words: /^(?:read|item get|document get)\b/, what: 'a 1Password secret' },
  { head: 'vault', words: /^(?:read|kv get|token create)\b/, what: 'a Vault secret' },
  { head: 'kubectl', words: /^(?:get|describe) secrets?\b/, what: 'a Kubernetes secret' },
  { head: 'oc', words: /^(?:get|describe) secrets?\b/, what: 'an OpenShift secret' },
  {
    head: 'helm',
    words: /^get (?:values|all|manifest)\b/,
    what: 'Helm release values, which often hold secrets',
  },
  { head: 'git', words: /^credential (?:fill|approve)\b/, what: 'a git credential' },
]

/** Why an argv prints a secret, if it does. `argv` is already unwrapped. */
export function tokenPrinterReason(argv: readonly string[]): string | null {
  const head = commandName(argv[0])
  // `gh auth status` is a read, except with the flag that prints the token.
  if (head === 'gh' && argv[1] === 'auth' && argv[2] === 'status') {
    return argv.some((arg) => arg === '--show-token' || arg === '-t')
      ? 'prints a GitHub token (gh auth status --show-token)'
      : null
  }
  if (head === 'git' && argv[1] === 'config') {
    // `git config [--global] credential.helper store` sets it; `--get` reads it.
    const key = argv.findIndex((arg) => /^credential\.(?:[^.]+\.)?helper$/.test(arg))
    // A `--get*` or `--list` form reads, whatever follows (shell-quote leaves the
    // `2` of `2>&1` behind as a word).
    const reads = argv.some((arg) => /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l)$/.test(arg))
    const changes =
      argv.some((arg) => /^--(?:unset|unset-all|add|replace-all)$/.test(arg)) ||
      (!reads && argv.slice(key + 1).some((arg) => !arg.startsWith('-')))
    if (key !== -1 && changes) return 'changes how git stores credentials'
  }
  const words = argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-'))
    .join(' ')
  const flags = argv.slice(1).join(' ')
  for (const printer of TOKEN_PRINTERS) {
    if (printer.head !== head) continue
    if (printer.words.test(words) || printer.words.test(flags)) return `prints ${printer.what}`
  }
  return null
}
