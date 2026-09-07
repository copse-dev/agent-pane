/**
 * The dependency install a run may do before its agent starts
 * (`docs/plans/thread-in-container.md`, decision A9).
 *
 * The guest's shell commands are off the network (decision A7), so an agent
 * cannot `pnpm install` for itself. When the user opts in, the worker does it
 * once, first, with the run's proxy: the checkout's lockfile decides the
 * command, the package registry is on the allowlist for the run, and the
 * agent finds `node_modules` in place. What the command is and where it runs
 * is decided here, pure, so it can be tested without a guest.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The one origin a dependency install reaches; pnpm and npm both use it. */
export const PACKAGE_REGISTRY_ORIGIN = 'registry.npmjs.org:443'

/**
 * Why a worker-side install is the shape: the guest workspace is a fresh
 * volume, so the store and `node_modules` share a filesystem and pnpm links
 * rather than copies. The store lives beside the checkout, not in it, so a
 * `git add -A` by the agent cannot sweep it into a commit.
 */
export const PNPM_STORE_DIR = '/workspace/.pnpm-store'

export interface DependencyInstall {
  /** What decided the command, for the log. */
  lockfile: string
  command: string
  args: string[]
}

/** The install for a checkout, by its lockfile; null when it has none we run. */
export function dependencyInstallFor(workspace: string): DependencyInstall | null {
  if (existsSync(join(workspace, 'pnpm-lock.yaml'))) {
    return {
      lockfile: 'pnpm-lock.yaml',
      command: 'pnpm',
      // append-only: pnpm's default reporter redraws the terminal, which a
      // log that is read line by line cannot show.
      args: [
        'install',
        '--frozen-lockfile',
        '--reporter=append-only',
        `--store-dir=${PNPM_STORE_DIR}`,
      ],
    }
  }
  if (existsSync(join(workspace, 'package-lock.json'))) {
    return {
      lockfile: 'package-lock.json',
      command: 'npm',
      args: ['ci', '--no-audit', '--no-fund', '--loglevel=error'],
    }
  }
  return null
}

/**
 * Environment for the install child: the run's proxy so the registry is
 * reachable, and every "download a binary in postinstall" switch off, because
 * those fetch from hosts the run does not admit (GitHub releases, browser
 * CDNs) and an install that needs them would only fail later and slower.
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
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PUPPETEER_SKIP_DOWNLOAD: '1',
    CYPRESS_INSTALL_BINARY: '0',
  }
}
