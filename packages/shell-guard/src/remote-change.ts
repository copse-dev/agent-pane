import { commandName } from './shell-argv.ts'

/**
 * Commands that change something a person relies on beyond this checkout:
 * publishing a package, deploying, changing cloud or cluster state, writing a
 * database, running a container with the host's privileges, installing from a
 * registry nobody configured, sending data to another host, opening a listener,
 * and sending mail. The public escalation-review test set found every one of
 * these running unprompted under Guarded YOLO.
 *
 * Cloud and deploy CLIs take an allow-list of their read subcommands, as `gh`
 * does: a verb nobody listed asks, so a new write does not slip through.
 */

const nonFlagWords = (argv: readonly string[]): string[] =>
  argv.slice(1).filter((arg) => !arg.startsWith('-'))

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function publishReason(argv: readonly string[]): string | null {
  const head = commandName(argv[0])
  const words = nonFlagWords(argv)
  const [first = '', second = ''] = words
  const publishes =
    (['npm', 'pnpm', 'yarn', 'bun'].includes(head) &&
      /^(?:publish|unpublish|deprecate|owner|access)$/.test(first)) ||
    (head === 'npm' && first === 'dist-tag' && /^(?:add|rm)$/.test(second)) ||
    (head === 'cargo' && /^(?:publish|yank|owner)$/.test(first)) ||
    (head === 'gem' && /^(?:push|yank|owner)$/.test(first)) ||
    (head === 'twine' && first === 'upload') ||
    ((head === 'poetry' || head === 'uv' || head === 'hatch' || head === 'flit') &&
      first === 'publish') ||
    (head === 'mvn' && words.includes('deploy')) ||
    (/^gradlew?$/.test(head) && words.some((word) => /^publish/.test(word))) ||
    (head === 'dotnet' && first === 'nuget' && second === 'push') ||
    ((head === 'docker' || head === 'podman') &&
      (first === 'push' || (first === 'image' && second === 'push') || argv.includes('--push')))
  return publishes ? `publishes to a registry (${head} ${first})` : null
}

// ---------------------------------------------------------------------------
// Clusters, clouds and deploy targets
// ---------------------------------------------------------------------------

const KUBE_READS = new Set([
  'get',
  'describe',
  'logs',
  'top',
  'version',
  'explain',
  'api-resources',
  'api-versions',
  'cluster-info',
  'diff',
  'events',
  'wait',
  'help',
  // A local tunnel to a service; nothing in the cluster changes.
  'port-forward',
])
const KUBE_READ_PAIRS =
  /^(?:config (?:view|get-\w+|current-context)|auth (?:can-i|whoami)|rollout (?:status|history))$/

function kubeReason(head: string, words: readonly string[]): string | null {
  const [first = '', second = ''] = words
  if (KUBE_READS.has(first) || KUBE_READ_PAIRS.test(`${first} ${second}`)) return null
  return `changes a Kubernetes cluster (${head} ${first || '(no subcommand)'})`
}

/** Deploy and infrastructure CLIs: the first word that reads, keyed by program. */
const FIRST_WORD_READS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    helm: new Set([
      'list',
      'ls',
      'status',
      'history',
      'show',
      'inspect',
      'template',
      'lint',
      'version',
      'search',
      'repo',
      'dependency',
      'env',
      'verify',
      'plugin',
      'get',
      'help',
    ]),
    terraform: new Set([
      'plan',
      'show',
      'validate',
      'fmt',
      'version',
      'output',
      'providers',
      'graph',
      'init',
      'get',
      'console',
      'state',
      'workspace',
      'help',
    ]),
    pulumi: new Set([
      'preview',
      'version',
      'whoami',
      'about',
      'stack',
      'config',
      'logs',
      'plugin',
      'help',
    ]),
    vercel: new Set(['ls', 'list', 'inspect', 'logs', 'whoami', 'help', 'dev', 'build', 'login']),
    netlify: new Set([
      'status',
      'sites:list',
      'logs',
      'help',
      'dev',
      'build',
      'link',
      'watch',
      'open',
    ]),
    fly: new Set(['status', 'logs', 'version', 'help', 'doctor', 'apps', 'config', 'auth']),
    firebase: new Set([
      'projects:list',
      'apps:list',
      'help',
      'serve',
      'emulators:start',
      'emulators:exec',
      'login',
    ]),
    heroku: new Set([
      'logs',
      'ps',
      'apps',
      'apps:info',
      'releases',
      'status',
      'help',
      'version',
      'login',
    ]),
    wrangler: new Set(['whoami', 'dev', 'tail', 'types', 'help', 'login']),
  }),
)
/** Second words that still write under a read-looking first word. */
const WRITING_SECOND_WORDS =
  /^(?:rm|remove|delete|destroy|set|import|push|mv|untaint|taint|force-unlock|select|new|unset|add|install|uninstall|upgrade|rollback|rename|init)$/

function deployReason(
  head: string,
  words: readonly string[],
  argv: readonly string[],
): string | null {
  const reads = FIRST_WORD_READS.get(
    head === 'tofu' ? 'terraform' : head === 'flyctl' ? 'fly' : head,
  )
  if (!reads) return null
  const [first = '', second = ''] = words
  // A bare `vercel` or `netlify` with only flags deploys; `--version`/`--help` do not.
  if (!first) {
    const informational = argv.slice(1).some((arg) => /^--?(?:v|version|h|help)$/.test(arg))
    return informational || (argv.length === 1 && head !== 'vercel')
      ? null
      : `deploys or changes infrastructure (${head})`
  }
  if (!reads.has(first)) return `deploys or changes infrastructure (${head} ${first})`
  // `terraform state rm`, `pulumi stack rm`, `helm repo add`, `fly apps destroy`.
  if (
    (head === 'terraform' ||
      head === 'tofu' ||
      head === 'pulumi' ||
      head === 'fly' ||
      head === 'flyctl') &&
    WRITING_SECOND_WORDS.test(second) &&
    !(first === 'workspace' && /^(?:select|new)$/.test(second)) &&
    !(first === 'stack' && second === 'select')
  ) {
    return `deploys or changes infrastructure (${head} ${first} ${second})`
  }
  if (head === 'pulumi' && first === 'config' && second === 'set') {
    return `deploys or changes infrastructure (${head} ${first} ${second})`
  }
  return null
}

const CLOUD_WRITE_VERB =
  /^(?:create|delete|deploy|update|set|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|patch|resize|start|stop|restart|reset|import|submit|run|enable|disable|apply|purge|assign|grant|revoke|upload|invoke|execute|attach|detach|move|rename|replace|scale|promote|rollback|cancel|terminate|reboot|login|activate-service-account|ssh|scp)$/

function cloudReason(
  head: string,
  words: readonly string[],
  argv: readonly string[],
): string | null {
  if (head === 'gcloud' || head === 'az' || head === 'doctl') {
    const verb = words.find((word) => CLOUD_WRITE_VERB.test(word))
    return verb ? `changes cloud resources (${head} … ${verb})` : null
  }
  if (head !== 'aws') return null
  const [service = '', op = ''] = words
  if (service === 's3') {
    if (op === 'ls' || op === 'presign') return null
    // `s3 cp s3://bucket/key ./local` downloads; anything that lands in S3 writes.
    const target = words.at(-1) ?? ''
    if (op === 'cp' && !target.startsWith('s3://') && !argv.includes('--delete')) return null
    return `changes cloud resources (aws s3 ${op})`
  }
  if (service === 'configure' && op === 'list') return null
  if (
    /^(?:describe|list|get|head|scan|query|lookup|search|filter|batch-get|validate|test|simulate|estimate|preview)-/.test(
      op,
    )
  ) {
    return null
  }
  if (service === 'sts' && op === 'get-caller-identity') return null
  if (service === 'logs' && /^(?:tail|filter-log-events)$/.test(op)) return null
  if (!service || service === 'help') return null
  return `changes cloud resources (aws ${service} ${op})`
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

function paymentReason(head: string, words: readonly string[]): string | null {
  if (head !== 'stripe') return null
  const reads =
    /^(?:list|retrieve|logs|listen|help|version|login|config|samples|completion|open|status|get)$/
  return words.length === 0 || words.some((word) => reads.test(word))
    ? null
    : `may create charges or change a Stripe account (stripe ${words.slice(0, 2).join(' ')})`
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const DATABASE_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'mongosh',
  'mongo',
  'redis-cli',
  'cqlsh',
  'clickhouse',
  'clickhouse-client',
  'duckdb',
])
const DATA_CHANGE =
  /\b(?:DROP\s+(?:DATABASE|TABLE|SCHEMA|USER|ROLE|INDEX|VIEW|COLLECTION)|TRUNCATE|DELETE\s+FROM|ALTER\s+(?:TABLE|USER|ROLE|DATABASE)|GRANT|REVOKE|UPDATE\s+\S+\s+SET|FLUSH(?:ALL|DB))\b|\.(?:drop(?:Database)?|deleteMany|deleteOne|remove|updateMany)\s*\(/i

function databaseReason(head: string, argv: readonly string[]): string | null {
  if (head === 'dropdb' || head === 'dropuser') return `deletes a database object (${head})`
  if (head === 'mysqladmin' && argv.includes('drop')) return 'deletes a database (mysqladmin drop)'
  if (!DATABASE_CLIENTS.has(head)) return null
  return DATA_CHANGE.test(argv.slice(1).join(' '))
    ? `changes or deletes database data (${head})`
    : null
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

const HOST_MOUNT =
  /^(?:\/|\/etc|\/var\/run\/docker\.sock|\/run\/docker\.sock|\/root|\/Users|\/home|~)(?::|$)/

function containerReason(
  head: string,
  words: readonly string[],
  argv: readonly string[],
): string | null {
  if (head !== 'docker' && head !== 'podman' && head !== 'nerdctl') return null
  const [first = '', second = ''] = words
  const verb = first === 'container' || first === 'image' ? second : first
  if (verb === 'run' || verb === 'create') {
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] ?? ''
      if (
        /^--privileged\b|^--(?:pid|ipc|userns|uts)=host$|^--cap-add=(?:ALL|SYS_ADMIN)$/i.test(arg)
      ) {
        return `runs a container with access to the host (${arg})`
      }
      const mount =
        arg === '-v' || arg === '--volume'
          ? (argv[i + 1] ?? '')
          : /^(?:-v|--volume=)(.+)$/.exec(arg)?.[1]
      if (mount !== undefined && HOST_MOUNT.test(mount)) {
        return `runs a container with access to the host (mounts ${mount.split(':')[0] ?? mount})`
      }
    }
    return null
  }
  if (
    /^(?:kill|stop|rm|rmi|restart|pause|prune)$/.test(verb) ||
    (first === 'system' && second === 'prune')
  ) {
    return `stops or removes containers or images the agent may not have started (${head} ${words.slice(0, 2).join(' ')})`
  }
  if ((first === 'volume' || first === 'network') && /^(?:rm|prune)$/.test(second)) {
    return `removes ${first}s the agent may not have created (${head} ${first} ${second})`
  }
  return null
}

// ---------------------------------------------------------------------------
// Package registries
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRIES =
  /^(?:https?:\/\/)?(?:registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org|proxy\.golang\.org|sum\.golang\.org|crates\.io|index\.crates\.io)(?:[/:]|$)/i

const REGISTRY_VARIABLE =
  /^(GOPROXY|GOSUMDB|GONOSUMDB|GONOSUMCHECK|GOINSECURE|GOPRIVATE|GOFLAGS|NPM_CONFIG_REGISTRY|npm_config_registry|YARN_REGISTRY|YARN_NPM_REGISTRY_SERVER|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_TRUSTED_HOST|UV_INDEX_URL|UV_EXTRA_INDEX_URL|UV_INDEX)=(.*)$/
const REGISTRY_FLAG =
  /^--(?:registry|index-url|extra-index-url|trusted-host|index|default-index)(?:=(.*))?$/

function registryReason(rawArgv: readonly string[], argv: readonly string[]): string | null {
  for (const token of rawArgv) {
    const match = REGISTRY_VARIABLE.exec(token)
    if (!match) continue
    const [, name = '', value = ''] = match
    if (name === 'GOSUMDB' && value !== 'off') continue
    if (name === 'GOFLAGS' && !/insecure/i.test(value)) continue
    if (name === 'GOPRIVATE') continue
    if (DEFAULT_REGISTRIES.test(value)) continue
    return `installs from a package registry other than the default (${name})`
  }
  for (let i = 1; i < argv.length; i++) {
    const match = REGISTRY_FLAG.exec(argv[i] ?? '')
    if (!match) continue
    const value = match[1] ?? argv[i + 1] ?? ''
    if (DEFAULT_REGISTRIES.test(value)) continue
    return `installs from a package registry other than the default (${(argv[i] ?? '').split('=')[0] ?? ''})`
  }
  return null
}

// ---------------------------------------------------------------------------
// Data sent to other hosts, listeners, mail
// ---------------------------------------------------------------------------

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.localhost)$/i

function urlHost(token: string): string | null {
  const match = /^["']?[a-z][\w+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#"']+)/i.exec(token)
  return match?.[1] ?? null
}

const CURL_BODY =
  /^(?:-d|--data(?:-\w+)?|-F|--form(?:-string)?|-T|--upload-file|--json)(?:=|$)|^-[A-Za-z]*[dFT]/
const WRITE_METHOD = /^(?:POST|PUT|PATCH|DELETE)$/i

function sendsBody(head: string, argv: readonly string[]): boolean {
  if (head === 'curl') {
    return argv.some(
      (arg, i) =>
        (i > 0 && CURL_BODY.test(arg)) ||
        ((arg === '-X' || arg === '--request') && WRITE_METHOD.test(argv[i + 1] ?? '')) ||
        /^(?:-X|--request=)(?:POST|PUT|PATCH|DELETE)$/i.test(arg),
    )
  }
  if (head === 'wget') {
    return argv.some((arg) =>
      /^--(?:post-(?:data|file)|body-(?:data|file)|method=(?:POST|PUT|PATCH|DELETE))\b/i.test(arg),
    )
  }
  if (head === 'http' || head === 'https' || head === 'xh') {
    return argv.some((arg) => WRITE_METHOD.test(arg))
  }
  return false
}

function uploadReason(head: string, argv: readonly string[]): string | null {
  if (!sendsBody(head, argv)) return null
  const hosts = argv
    .slice(1)
    .map(urlHost)
    .filter((host) => host !== null)
  if (hosts.length > 0 && hosts.every((host) => LOOPBACK.test(host))) return null
  return `sends data to another host (${head}${hosts.length ? ` to ${[...new Set(hosts)].join(', ')}` : ''})`
}

function listenerReason(head: string, argv: readonly string[]): string | null {
  if (head === 'socat') return 'opens a network relay (socat)'
  if (head === 'nc' || head === 'ncat' || head === 'netcat') {
    const listens = argv.some((arg) =>
      /^-[A-Za-z]*[lec]|^--(?:listen|exec|sh-exec|lua-exec)\b/.test(arg),
    )
    return listens ? `opens a network listener or runs a program for it (${head})` : null
  }
  return null
}

const MAIL_CLIENTS = new Set(['mail', 'mailx', 'sendmail', 'msmtp', 'mutt', 'swaks'])

// ---------------------------------------------------------------------------

/** Every remote-change reason for one segment. `argv` is unwrapped; `rawArgv` is not. */
export function remoteChangeReasons(rawArgv: readonly string[], argv: readonly string[]): string[] {
  const head = commandName(argv[0])
  const words = nonFlagWords(argv)
  const reasons = [
    publishReason(argv),
    head === 'kubectl' || head === 'oc' ? kubeReason(head, words) : null,
    deployReason(head, words, argv),
    cloudReason(head, words, argv),
    paymentReason(head, words),
    databaseReason(head, argv),
    containerReason(head, words, argv),
    registryReason(rawArgv, argv),
    uploadReason(head, argv),
    listenerReason(head, argv),
    MAIL_CLIENTS.has(head) ? `sends email (${head})` : null,
  ]
  return reasons.filter((reason) => reason !== null)
}
