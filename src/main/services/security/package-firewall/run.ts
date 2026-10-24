import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { copseCacheDir } from '../../storage/copse-paths.ts'
import {
  AdvisoryChecker,
  manifestAdvisoryLookup,
  memoizedManifests,
  osvAdvisoryLookup,
} from './advisories.ts'
import { downloadsDisabledChildEnv, firewallTrust, packageFirewallChildEnv } from './child-env.ts'
import {
  blockedMessage,
  startPackageFirewallProxy,
  type FirewallDecision,
  type RunningFirewallProxy,
} from './proxy.ts'
import { INTERCEPTED_REGISTRY_HOSTS, packageKey, type MetadataTarget } from './registry-targets.ts'
import { DEFAULT_MIN_RELEASE_AGE_MS, describeReleaseAge } from './release-age.ts'
import {
  connectUpstream,
  fetchUpstreamText,
  upstreamConfigFromEnv,
  UpstreamHttpsAgent,
} from './upstream.ts'
import { createCertificateAuthority } from './x509.ts'

/**
 * `package-firewall <command> [args…]`: run one command with its registry
 * downloads checked against public malware advisories, and versions published
 * in the last 48 hours left out of what it resolves, then exit with the
 * command's status. See docs/plans/package-firewall.md.
 *
 * It stays quiet unless it has to act: the only lines it prints are a refused
 * download, the packages whose recent versions were left out, and the
 * conditions that stop it from proxying at all. Clean and unverifiable
 * downloads are not reported, so nothing reads as a guarantee.
 */

/** Shared with the shell tool's own install banner. */
export const FIREWALL_LOG_PREFIX = '[safe-install]'

const ADVISORY_TIMEOUT_MS = 15_000
const OSV_MAX_BYTES = 8 * 1024 * 1024
const FEED_MAX_BYTES = 32 * 1024 * 1024

/** The blocked line, with an OSV link for each `MAL-` advisory. */
export function blockedLogLine(decision: FirewallDecision): string {
  const links = decision.verdict.advisories
    .filter((advisory) => advisory.startsWith('MAL-'))
    .map((id) => `https://osv.dev/vulnerability/${id}`)
  const suffix = links.length > 0 ? ` (${links.join(', ')})` : ''
  return `${FIREWALL_LOG_PREFIX} ${blockedMessage(decision.pkg, decision.verdict)}${suffix}`
}

/** Packages named in the recent-versions line before it summarises the rest. */
const RECENT_PACKAGES_SHOWN = 8

/**
 * One line naming each package that had versions left out, with its newest
 * left-out version, so a resolution that settled on an older version explains
 * itself. `recent` maps a package to its left-out versions, newest first.
 */
export function recentVersionsLogLine(
  recent: ReadonlyMap<string, { target: MetadataTarget; hidden: readonly string[] }>,
  minAgeMs: number,
): string | null {
  if (recent.size === 0) return null
  const named = [...recent.values()].map(({ target, hidden }) =>
    hidden[0] === undefined ? target.name : `${target.name}@${hidden[0]}`,
  )
  const shown = named.slice(0, RECENT_PACKAGES_SHOWN).join(', ')
  const more = named.length - RECENT_PACKAGES_SHOWN
  const suffix = more > 0 ? ` and ${String(more)} more ${more === 1 ? 'package' : 'packages'}` : ''
  return (
    `${FIREWALL_LOG_PREFIX} Ignored versions published in the last ` +
    `${describeReleaseAge(minAgeMs)}: ${shown}${suffix}`
  )
}

/** The errno when a listen failed for lack of permission, as inside a contained sandbox. */
function listenDenied(error: unknown): 'EPERM' | 'EACCES' | null {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return null
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value
  return code === 'EPERM' || code === 'EACCES' ? code : null
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  return 128 + (signal ? constants.signals[signal] : 0)
}

/**
 * Windows resolves `npm.cmd` and friends only through cmd.exe, so there the
 * command line is quoted for cmd and run through the shell, as the shell tool's
 * own `cmd /c` wrapping expects.
 */
function spawnCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  if (process.platform !== 'win32') return spawn(command, args, { stdio: 'inherit', env })
  const line = [command, ...args]
    .map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part))
    .join(' ')
  return spawn(line, { stdio: 'inherit', env, shell: true })
}

function runChild(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnCommand(command, args, env)
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal)
    }
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    for (const signal of signals) process.on(signal, forward)
    const finish = (status: number): void => {
      for (const signal of signals) process.off(signal, forward)
      resolve(status)
    }
    child.once('error', (error) => {
      log(`${FIREWALL_LOG_PREFIX} could not start ${command}: ${error.message}`)
      finish(127)
    })
    child.once('exit', (code, signal) => {
      finish(exitStatus(code, signal))
    })
  })
}

export async function runPackageFirewall(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<number> {
  const [command, ...args] = argv
  if (!command) {
    log(`${FIREWALL_LOG_PREFIX} usage: package-firewall <command> [args…]`)
    return 64
  }

  const upstream = upstreamConfigFromEnv(env)
  const agent = new UpstreamHttpsAgent(upstream)
  const checker = new AdvisoryChecker([
    osvAdvisoryLookup((url, body) =>
      fetchUpstreamText(
        url,
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          timeoutMs: ADVISORY_TIMEOUT_MS,
          maxBytes: OSV_MAX_BYTES,
        },
        agent,
      ),
    ),
    manifestAdvisoryLookup(
      memoizedManifests({
        cacheDir: join(copseCacheDir(env), 'package-firewall', 'feeds'),
        fetchText: (url) =>
          fetchUpstreamText(
            url,
            { timeoutMs: ADVISORY_TIMEOUT_MS, maxBytes: FEED_MAX_BYTES },
            agent,
          ),
      }),
    ),
  ])

  const reportedBlocks = new Set<string>()
  const unreachableHosts = new Set<string>()
  const recent = new Map<string, { target: MetadataTarget; hidden: readonly string[] }>()
  const authority = createCertificateAuthority({
    permittedHosts: [...INTERCEPTED_REGISTRY_HOSTS.keys()],
  })
  let proxy: RunningFirewallProxy
  try {
    proxy = await startPackageFirewallProxy({
      authority,
      token: randomBytes(24).toString('hex'),
      check: (pkg) => checker.check(pkg),
      connectTunnel: (host, port) => connectUpstream(host, port, upstream),
      registryAgent: agent,
      releaseAge: { minAgeMs: DEFAULT_MIN_RELEASE_AGE_MS },
      onRecentVersions: (target, hidden) => {
        recent.set(`${target.ecosystem}:${target.name}`, { target, hidden })
      },
      onDecision: (decision) => {
        const key = packageKey(decision.pkg)
        if (decision.verdict.status !== 'blocked' || reportedBlocks.has(key)) return
        reportedBlocks.add(key)
        log(blockedLogLine(decision))
      },
      onUnreachable: (host, error) => {
        if (unreachableHosts.has(host)) return
        unreachableHosts.add(host)
        log(`${FIREWALL_LOG_PREFIX} could not reach ${host}: ${error.message}`)
      },
    })
  } catch (error) {
    agent.destroy()
    const denied = listenDenied(error)
    if (!denied) throw error
    log(
      `${FIREWALL_LOG_PREFIX} cannot listen on loopback here (${denied}); ` +
        'package downloads are disabled for this command',
    )
    return runChild(command, args, downloadsDisabledChildEnv(env), log)
  }

  // Only the CA *certificate* is written; its key never leaves this process.
  const dir = mkdtempSync(join(tmpdir(), 'copse-package-firewall-'))
  try {
    const trust = await firewallTrust(authority.certPem, env)
    const extraCaFile = join(dir, 'extra-ca.pem')
    const fullBundleFile = join(dir, 'ca-bundle.pem')
    writeFileSync(extraCaFile, trust.extraCaPem, { mode: 0o600 })
    writeFileSync(fullBundleFile, trust.fullBundlePem, { mode: 0o600 })
    const status = await runChild(
      command,
      args,
      packageFirewallChildEnv(env, { proxyUrl: proxy.url, extraCaFile, fullBundleFile }),
      log,
    )
    const line = recentVersionsLogLine(recent, DEFAULT_MIN_RELEASE_AGE_MS)
    if (line) log(line)
    return status
  } finally {
    await proxy.close()
    agent.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}
