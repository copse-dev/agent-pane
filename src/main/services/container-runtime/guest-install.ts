/**
 * The dependency install a run may do before its agent starts
 * (`docs/plans/thread-in-container.md`, decision A9).
 *
 * The guest's shell commands are off the network (decision A7), so an agent
 * cannot `pnpm install` for itself. When the user opts in, the worker does it
 * once, first, with the run's proxy: the checkout's lockfile decides the
 * command, the package registry is on the allowlist for the run, and the
 * agent finds `node_modules` in place. What the steps are and where they run
 * is decided here, pure, so it can be tested without a guest.
 *
 * Three steps rather than one. Fetching and linking every package with
 * lifecycle scripts off is the part that must succeed, and it only needs the
 * registry. Building native modules and running the project's own postinstall
 * come after, best effort: an install script that downloads a browser driver
 * from a host the run never admits fails on its own, and the first real run
 * showed one such script failing the whole install with `node_modules`
 * already complete.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The registry pnpm and npm both fetch from. */
export const PACKAGE_REGISTRY_ORIGIN = 'registry.npmjs.org:443'

/**
 * What a dependency install may reach (decision A11): the registry, and
 * GitHub for the release assets that install scripts fetch — Electron, a
 * chromedriver — plus raw files and the API. Anonymous HTTPS only: the guest
 * holds no GitHub token, no `gh`, no credential helper and no SSH agent, and
 * GitHub requires a token for every write, so this admits reads and nothing
 * else. The hosts are named in full because they are several: release assets
 * redirect to objects.githubusercontent.com, raw files live on
 * raw.githubusercontent.com.
 */
export const DEPENDENCY_INSTALL_ORIGINS: readonly string[] = [
  PACKAGE_REGISTRY_ORIGIN,
  'github.com:443',
  '*.github.com:443',
  '*.githubusercontent.com:443',
]

/**
 * The guest workspace is a fresh volume, so the store and `node_modules`
 * share a filesystem and pnpm links rather than copies. The store lives beside
 * the checkout, not in it, so a `git add -A` by the agent cannot sweep it in.
 */
export const PNPM_STORE_DIR = '/workspace/.pnpm-store'

export interface DependencyInstallStep {
  /** For the log. */
  label: string
  command: string
  args: string[]
  /** A required step that fails ends the install; an optional one is reported and passed over. */
  required: boolean
}

export interface DependencyInstall {
  /** What decided the steps, for the log. */
  lockfile: string
  steps: DependencyInstallStep[]
}

/** The lifecycle scripts the project itself declares, in the order npm would run them. */
function rootLifecycleScripts(workspace: string): string[] {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('scripts' in manifest)) return []
    const scripts: unknown = manifest.scripts
    if (typeof scripts !== 'object' || scripts === null) return []
    return ['postinstall', 'prepare'].filter((name) => Object.hasOwn(scripts, name))
  } catch {
    return []
  }
}

/** The install for a checkout, by its lockfile; null when it has none we run. */
export function dependencyInstallFor(workspace: string): DependencyInstall | null {
  const lifecycle = rootLifecycleScripts(workspace)
  if (existsSync(join(workspace, 'pnpm-lock.yaml'))) {
    // append-only: pnpm's default reporter redraws the terminal, which a log
    // read line by line cannot show.
    const reporter = '--reporter=append-only'
    return {
      lockfile: 'pnpm-lock.yaml',
      steps: [
        {
          label: 'fetch and link',
          command: 'pnpm',
          args: [
            'install',
            '--frozen-lockfile',
            '--ignore-scripts',
            reporter,
            `--store-dir=${PNPM_STORE_DIR}`,
          ],
          required: true,
        },
        {
          label: 'build native modules',
          command: 'pnpm',
          args: ['rebuild', reporter],
          required: false,
        },
        ...lifecycle.map((name) => ({
          label: `project ${name}`,
          command: 'pnpm',
          args: ['run', name],
          required: false,
        })),
      ],
    }
  }
  if (existsSync(join(workspace, 'package-lock.json'))) {
    const quiet = ['--no-audit', '--no-fund', '--loglevel=error']
    return {
      lockfile: 'package-lock.json',
      steps: [
        {
          label: 'fetch and link',
          command: 'npm',
          args: ['ci', '--ignore-scripts', ...quiet],
          required: true,
        },
        {
          label: 'build native modules',
          command: 'npm',
          args: ['rebuild', ...quiet],
          required: false,
        },
        ...lifecycle.map((name) => ({
          label: `project ${name}`,
          command: 'npm',
          args: ['run', name, ...quiet],
          required: false,
        })),
      ],
    }
  }
  return null
}

/**
 * Environment for the install children: the run's proxy so the registry and
 * GitHub are reachable, and the "download a binary in postinstall" switches
 * off for the fetches that go to hosts the run does not admit — browser CDNs —
 * because an install that waited on them would only fail later and slower.
 * Electron's own download is not switched off: it comes from GitHub releases,
 * which the install admits, and the e2e suite needs the binary.
 */
export function dependencyInstallEnv(
  base: NodeJS.ProcessEnv,
  proxy: { url: string; noProxy: string } | null,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(proxy
      ? {
          HTTPS_PROXY: proxy.url,
          HTTP_PROXY: proxy.url,
          https_proxy: proxy.url,
          http_proxy: proxy.url,
          NO_PROXY: proxy.noProxy,
          no_proxy: proxy.noProxy,
        }
      : {}),
    CI: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PUPPETEER_SKIP_DOWNLOAD: '1',
    CYPRESS_INSTALL_BINARY: '0',
  }
}
