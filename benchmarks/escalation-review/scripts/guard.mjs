// Bundle Copse's deterministic shell analysis (the `@copse/shell-guard` package plus
// the app's auto-approval classifier) into a throwaway ESM module, so the
// escalation-review scripts judge commands with the product's own code rather
// than a copy of it. Host settings and environment binders are excluded.
import { mkdtemp } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const scripts = dirname(fileURLToPath(import.meta.url))
export const repository = resolve(scripts, '../../..')
export const benchmark = resolve(scripts, '..')

export async function loadGuard() {
  const esbuild = createRequire(resolve(repository, 'package.json'))('esbuild')
  const sourceRoot = resolve(repository, 'packages/shell-guard/src')
  const appSecurity = resolve(repository, 'src/main/services/security')
  const bundle = join(await mkdtemp(join(tmpdir(), 'escalation-guard-')), 'guard.mjs')
  const built = await esbuild.build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(resolve(sourceRoot, 'index.ts'))};`,
        `export { assessAutoApproval } from ${JSON.stringify(resolve(appSecurity, 'auto-approval.ts'))};`,
      ].join('\n'),
      resolveDir: repository,
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    logLevel: 'error',
    alias: { '@shared': resolve(repository, 'src/shared'), '@copse/shell-guard': sourceRoot },
    plugins: [
      {
        name: 'pure-guard',
        setup(build) {
          build.onResolve(
            { filter: /^\.\/(shell-scope|shell-argv|command-routing|shell-harm)\.ts$/ },
            (args) =>
              args.importer.startsWith(appSecurity)
                ? { path: resolve(sourceRoot, args.path) }
                : null,
          )
        },
      },
    ],
  })
  if (
    Object.keys(built.metafile.inputs).some((name) => /shell-guard-environment|settings/.test(name))
  ) {
    throw new Error('The guard bundle must not include host settings or environment binders.')
  }
  const guard = await import(pathToFileURL(bundle).href)
  guard.configureShellScopeEnvironment()
  return guard
}

export function canonicalizePath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Every deterministic verdict the escalation review scores, for one command.
 * The file readers default to the permission gate's own (`script-files.ts`);
 * regression cases inject fixtures.
 */
export function analyze(guard, command, workspaceRoot, options = {}) {
  const {
    configuredRemotes = [],
    homeDir = process.env.HOME ?? '/',
    readScript = guard.readScriptForHarm,
    isCompiledProgram = guard.isCompiledProgram,
    pathExists = existsSync,
    trustedSshHosts = [],
  } = options
  const scope = guard.analyzeShellCommand(command, workspaceRoot)
  const autoApproval = {}
  let autoApprovalReasons = []
  for (const level of ['read', 'local-write', 'remote-write']) {
    const decision = guard.assessAutoApproval(command, {
      workspaceRoot,
      level,
      configuredRemotes: new Set(configuredRemotes),
      canonicalizePath,
    })
    autoApproval[level] = decision.action === 'auto-approve' ? decision.tier : null
    if (level === 'read' && decision.action !== 'auto-approve')
      autoApprovalReasons = decision.reasons
  }
  const readOutside = guard.analyzeReadOutsideProject(command, workspaceRoot, { homeDir })
  let harm
  try {
    harm = guard.assessShellHarm(command, {
      workspaceRoot,
      homeDir,
      canonicalizePath,
      readScript,
      isCompiledProgram,
      pathExists,
      trustedSshHosts,
    })
  } catch (error) {
    harm = { action: 'error', reasons: [String(error)] }
  }
  return {
    scope: scope.verdict,
    scopeReasons: scope.reasons.map(String),
    dangerous: guard.dangerousInSandboxReasons(command),
    autoApproval,
    autoApprovalReasons,
    readOutside: Boolean(readOutside.eligible),
    harm: harm.action,
    harmReasons: harm.reasons ?? [],
  }
}
