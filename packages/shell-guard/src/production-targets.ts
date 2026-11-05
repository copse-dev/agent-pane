/**
 * Production targets (Settings → Permissions).
 *
 * Kept free of Node built-ins so the Settings renderer can import it. Under
 * Guarded YOLO the harm gate lets infrastructure reads such as `kubectl get` and
 * `aws s3 ls` run without asking. A user who names their production cluster
 * contexts, namespaces, cloud projects or hosts here makes any infrastructure,
 * remote-shell or database command that names one ask once, reads included.
 *
 * The rule only ever adds a prompt. Matching is on whole words a command passes
 * (`--context=prod-eu`, `deploy@db.prod.example`, `postgres://db.prod.example/x`),
 * never substrings, so `prod` does not match `prod-staging`.
 */

/** Setting key holding the production target names, lower-case. */
export const PRODUCTION_TARGETS_SETTING = 'productionTargets'

// A context, namespace, project, profile or host name: no whitespace, quotes or
// shell metacharacters.
const VALID_TARGET = /^[a-z0-9][a-z0-9._:/-]{0,252}$/

/** Programs that act on infrastructure, other machines or databases. */
const TARGET_CLIS: ReadonlySet<string> = new Set([
  'kubectl',
  'oc',
  'helm',
  'stern',
  'k9s',
  'kubectx',
  'kubens',
  'terraform',
  'terragrunt',
  'tofu',
  'pulumi',
  'aws',
  'gcloud',
  'gsutil',
  'bq',
  'az',
  'doctl',
  'fly',
  'flyctl',
  'heroku',
  'vercel',
  'netlify',
  'wrangler',
  'firebase',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'mosh',
  'autossh',
  'psql',
  'pg_dump',
  'mysql',
  'mysqldump',
  'mongosh',
  'mongo',
  'redis-cli',
  'docker',
  'podman',
  'ansible',
  'ansible-playbook',
])

export function normalizeProductionTarget(target: string): string {
  return target.trim().toLowerCase()
}

function collect(entries: Iterable<unknown>): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const target = normalizeProductionTarget(entry)
    if (!target || out.includes(target) || !VALID_TARGET.test(target)) continue
    out.push(target)
  }
  return out
}

/** Parse the one-per-line textarea. Blank lines and `#` comments are skipped. */
export function parseProductionTargets(text: string): string[] {
  return collect(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )
}

/** Validate a value from the settings store, dropping malformed entries. */
export function sanitizeProductionTargets(value: unknown): string[] {
  return Array.isArray(value) ? collect(value) : []
}

/** The whole words one argument names: itself, an option's value, a user@host's host, a URL's host. */
function argumentWords(arg: string): string[] {
  const words = new Set<string>()
  const add = (word: string): void => {
    const normalized = normalizeProductionTarget(word)
    if (normalized) words.add(normalized)
  }
  add(arg)
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg
  add(value)
  try {
    const url = new URL(value)
    if (url.hostname) add(url.hostname)
  } catch {
    // Not a URL.
  }
  const afterUser = value.slice(value.lastIndexOf('@') + 1)
  add(afterUser)
  // `host:path`, `host:port`.
  add(afterUser.split(':')[0] ?? '')
  return [...words]
}

/**
 * The prompt reason when a segment's program acts on infrastructure, other
 * machines or databases and names a production target, or null. `argv` is
 * unwrapped; `rawArgv` keeps leading assignments such as `AWS_PROFILE=prod`.
 */
export function productionTargetReason(
  rawArgv: readonly string[],
  argv: readonly string[],
  head: string,
  targets: readonly string[],
): string | null {
  if (targets.length === 0 || !TARGET_CLIS.has(head)) return null
  const wanted = new Set(targets.map(normalizeProductionTarget))
  for (const arg of [...rawArgv, ...argv.slice(1)]) {
    for (const word of argumentWords(arg)) {
      if (wanted.has(word)) return `reaches a production target (${word})`
    }
  }
  return null
}
