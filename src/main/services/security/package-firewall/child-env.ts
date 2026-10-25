import { readFile } from 'node:fs/promises'
import { rootCertificates } from 'node:tls'
import { INTERCEPTED_REGISTRY_HOSTS } from './registry-targets.ts'
import { hostBypassesProxy, parseNoProxy } from './upstream.ts'

/**
 * The environment a firewalled command runs with: every supported package
 * manager is pointed at the firewall's proxy and told to trust its CA.
 *
 * | Manager            | Proxy                                             | Trust                    |
 * | ------------------ | ------------------------------------------------- | ------------------------ |
 * | npm, pnpm, Yarn 1  | `npm_config_https_proxy`, `HTTPS_PROXY`           | `NODE_EXTRA_CA_CERTS`    |
 * | Yarn 2+            | `YARN_HTTPS_PROXY`                                | `NODE_EXTRA_CA_CERTS`    |
 * | pip                | `PIP_PROXY`, `HTTPS_PROXY`                        | `PIP_CERT`               |
 * | uv                 | `HTTPS_PROXY`                                     | `SSL_CERT_FILE`          |
 * | cargo              | `CARGO_HTTP_PROXY`                                | `CARGO_HTTP_CAINFO`      |
 *
 * Variables that *replace* a tool's trust store get a full bundle: Node's roots,
 * the system bundle, any bundle the user already configured, and the firewall
 * CA. So hosts the firewall only tunnels keep verifying exactly as before.
 * `YARN_HTTPS_CA_FILE_PATH` is deliberately unset: Yarn 2 and 3 reject it.
 */

const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'npm_config_https_proxy',
  'npm_config_proxy',
  'YARN_HTTPS_PROXY',
  'YARN_HTTP_PROXY',
  'PIP_PROXY',
  'CARGO_HTTP_PROXY',
] as const

const REPLACING_TRUST_VARIABLES = [
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'PIP_CERT',
  'CARGO_HTTP_CAINFO',
] as const

const SYSTEM_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/ssl/cert.pem',
]

/** Drop `NO_PROXY` entries that would route an intercepted registry around the firewall. */
export function withoutFirewallBypass(value: string | undefined): string {
  const hosts = [...INTERCEPTED_REGISTRY_HOSTS.keys()]
  return parseNoProxy(value)
    .filter((entry) => !hosts.some((host) => hostBypassesProxy(host, 443, [entry])))
    .join(',')
}

async function certificatesIn(path: string | undefined): Promise<string[]> {
  if (!path) return []
  try {
    return (
      (await readFile(path, 'utf8')).match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      ) ?? []
    )
  } catch {
    return []
  }
}

function bundle(certificates: readonly string[]): string {
  return `${[...new Set(certificates.map((pem) => pem.trim()))].join('\n')}\n`
}

export interface FirewallTrust {
  /** The firewall CA plus the user's own `NODE_EXTRA_CA_CERTS`. */
  extraCaPem: string
  /** A complete trust store for variables that replace a tool's defaults. */
  fullBundlePem: string
}

export async function firewallTrust(caPem: string, env: NodeJS.ProcessEnv): Promise<FirewallTrust> {
  const [userExtra, userBundles, system] = await Promise.all([
    certificatesIn(env['NODE_EXTRA_CA_CERTS']),
    Promise.all(REPLACING_TRUST_VARIABLES.map((key) => certificatesIn(env[key]))),
    Promise.all(SYSTEM_BUNDLES.map((path) => certificatesIn(path))),
  ])
  return {
    extraCaPem: bundle([caPem, ...userExtra]),
    fullBundlePem: bundle([
      caPem,
      ...userExtra,
      ...userBundles.flat(),
      ...system.flat(),
      ...rootCertificates,
    ]),
  }
}

export interface FirewallChildSettings {
  proxyUrl: string
  extraCaFile: string
  fullBundleFile: string
}

/** Point every supported manager at `proxyUrl`, with no registry exempt via `NO_PROXY`. */
function proxiedEnv(base: NodeJS.ProcessEnv, proxyUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  // The wrapper itself runs as Node; whatever it launches must not.
  delete env['ELECTRON_RUN_AS_NODE']
  for (const key of PROXY_VARIABLES) env[key] = proxyUrl
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    if (base[key] !== undefined) env[key] = withoutFirewallBypass(base[key])
  }
  // Always set, so an `.npmrc` `noproxy` cannot exempt the registry either.
  env['npm_config_noproxy'] = withoutFirewallBypass(
    base['npm_config_noproxy'] ?? base['NO_PROXY'] ?? base['no_proxy'],
  )
  return env
}

export function packageFirewallChildEnv(
  base: NodeJS.ProcessEnv,
  settings: FirewallChildSettings,
): NodeJS.ProcessEnv {
  const env = proxiedEnv(base, settings.proxyUrl)
  env['NODE_EXTRA_CA_CERTS'] = settings.extraCaFile
  for (const key of REPLACING_TRUST_VARIABLES) env[key] = settings.fullBundleFile
  return env
}

/** A proxy address nothing listens on (the discard port). */
export const CLOSED_PROXY_URL = 'http://127.0.0.1:9'

/**
 * For a wrapper that cannot open its proxy (a sandbox that denies loopback
 * binding): registry downloads fail instead of bypassing the firewall, while a
 * command that needs no download (`npx tsx` with tsx installed) still runs.
 */
export function downloadsDisabledChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return proxiedEnv(base, CLOSED_PROXY_URL)
}
