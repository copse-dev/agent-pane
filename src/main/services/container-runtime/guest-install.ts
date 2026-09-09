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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
  // electron-rebuild fetches Electron's headers from the project's own CDN
  // when it builds native modules against Electron rather than Node.
  'electronjs.org:443',
  '*.electronjs.org:443',
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
  /** Where to run; the checkout when absent. */
  cwd?: string
  /** A required step that fails ends the install; an optional one is reported and passed over. */
  required: boolean
  /**
   * Decided when the step's turn comes, because earlier steps create what it
   * looks at: false skips the step without a word.
   */
  when?: () => boolean
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

/**
 * Electron's binary comes from its own install script, which pnpm 10 runs
 * only for packages the project allows to build — and projects that rely on
 * their test runner to fetch the binary on demand do not list it. The runner
 * cannot fetch in the guest (the agent's shell is offline), so the install
 * does it, once, when the package is there and its `dist` is not.
 */
export function electronBinaryStep(workspace: string): DependencyInstallStep {
  const electron = join(workspace, 'node_modules', 'electron')
  return {
    label: 'fetch the Electron binary',
    command: 'node',
    args: ['install.js'],
    cwd: electron,
    required: false,
    when: () =>
      existsSync(join(electron, 'install.js')) && !existsSync(join(electron, 'dist', 'electron')),
  }
}

/**
 * The checkout's `origin`, for the guest's clone: the bundle carries no
 * remotes, and tests and tools that ask `git remote get-url origin` should
 * get the same answer they would on the desktop. Only the address crosses —
 * a token in the URL's userinfo is stripped, and the guest has no route to
 * the host anyway.
 */
export function sanitizedOriginUrl(url: string | null): string | null {
  if (url === null) return null
  const trimmed = url.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed = new URL(trimmed)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    // scp-like (`git@github.com:org/repo.git`) or a path: nothing to strip.
    return trimmed
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
        electronBinaryStep(workspace),
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
        electronBinaryStep(workspace),
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
  options: {
    /**
     * Where the running Node's headers are (`<dir>/include/node`), so node-gyp
     * builds against them instead of fetching a tarball from nodejs.org, which
     * the run does not admit. The official Node image ships them.
     */
    nodeDir?: string
  } = {},
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(options.nodeDir !== undefined ? { npm_config_nodedir: options.nodeDir } : {}),
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

/** What the install left the agent with, for the note it is given. */
export interface DependencyInstallSummary {
  lockfile: string | null
  /** Steps that did not exit 0, by label; empty when everything passed. */
  failed: string[]
  /** The required step failed: nothing usable was linked. */
  aborted: boolean
}

/**
 * The first lines of the prompt an agent in the guest is given (decision A9).
 * The first real run without one spent itself on `pnpm install` from a shell
 * that has no network, which tore down a working `node_modules`, and then on
 * asking to provision a cloud host. The agent is told what it has and what
 * it cannot do, once, in plain terms, before the task.
 */
export function guestEnvironmentNote(install: DependencyInstallSummary | null): string {
  const lines = [
    'Environment: a disposable Linux container. Shell commands have no network access at all — ' +
      'no package registry, no GitHub, no cloud: do not run installs, fetches, pushes or ' +
      'provisioning; they fail and an install attempt damages node_modules. Commits you make ' +
      'are carried back for review; nothing else leaves the container.',
  ]
  if (install === null) {
    lines.push('Dependencies were not installed for this run.')
  } else if (install.lockfile === null) {
    lines.push('No lockfile was found, so no dependencies were installed.')
  } else if (install.aborted) {
    lines.push(
      `The dependency install from ${install.lockfile} failed before linking; treat node_modules as absent.`,
    )
  } else if (install.failed.length === 0) {
    lines.push(`Dependencies were installed from ${install.lockfile} before you started.`)
  } else {
    lines.push(
      `Dependencies were installed from ${install.lockfile} before you started; these steps failed and ` +
        `were skipped: ${install.failed.join(', ')}. Packages whose install scripts failed may not work; ` +
        'the install log above your task says which.',
    )
  }
  return lines.join('\n')
}

/**
 * Whether the run's volume still takes writes, in a sentence when it does
 * not. A real run failed halfway through its install with EROFS, then died
 * on a mkdir under the home with ENOENT: the volume had gone away under the
 * container (Docker's VM disk full, or the mount lost), and every path under
 * it fell through to the read-only rootfs. Neither error said so. The probe
 * writes and removes one file where the checkout lives; the message names
 * the two causes worth checking rather than the syscall that happened to
 * notice first.
 */
export function volumeTrouble(dir: string): string | null {
  const probe = join(dir, '.copse-write-probe')
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
    return null
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'unknown error'
    return `the run's volume at ${dir} no longer takes writes (${code}): it is no longer mounted, or the disk Docker keeps its volumes on is full`
  }
}
