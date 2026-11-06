import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { it } from 'node:test'
import { createToolchainReadGuard, toolchainReadExceptions } from './toolchain-read-guard.ts'

it('protects named and canonical credential stores, their ancestors and configured locations', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'toolchain-read-guard-')))
  try {
    const profile = join(home, 'profile')
    const codex = join(home, 'codex-profile')
    const data = join(profile, 'user-data')
    const cache = join(profile, 'cache', 'corepack')
    const ssh = join(home, '.ssh')
    for (const path of [data, codex, ssh, cache]) mkdirSync(path, { recursive: true })
    for (const path of [
      join(ssh, 'id_ed25519'),
      join(data, 'config.json'),
      join(codex, 'auth.json'),
    ])
      writeFileSync(path, 'synthetic credential\n')
    const guard = createToolchainReadGuard({ COPSE_DIR: profile, CODEX_HOME: codex }, home)
    for (const path of [home, dirname(home), profile, data, codex, ssh]) {
      assert.equal(guard(path, true), null, path)
      const alias = join(home, 'alias')
      symlinkSync(path, alias)
      assert.equal(guard(alias, true), null, path)
      rmSync(alias)
    }
    for (const path of [
      join(ssh, 'id_ed25519'),
      join(data, 'config.json'),
      join(codex, 'auth.json'),
    ]) {
      const alias = join(home, 'node')
      symlinkSync(path, alias)
      assert.equal(guard(alias, false), null, path)
      rmSync(alias)
    }
    assert.equal(guard(cache, true), cache)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('keeps only canonical safe targets and rejects wildcard grant names', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'toolchain-canonical-guard-')))
  try {
    const target = join(home, 'safe-cache')
    const alias = join(home, 'alias')
    const wildcard = join(home, 'cache*')
    mkdirSync(target)
    mkdirSync(wildcard)
    symlinkSync(target, alias)
    const guard = createToolchainReadGuard({}, home)
    assert.equal(guard(alias, true), target)
    assert.equal(guard(target, false), null, 'a directory is not a file exception')
    assert.equal(guard(wildcard, true), null)
    rmSync(alias)
    symlinkSync(wildcard, alias)
    assert.equal(guard(alias, true), null)
    assert.deepEqual(toolchainReadExceptions([target, `${target}/**`], [home], [home]), [])
    assert.deepEqual(toolchainReadExceptions([home], [home], [target]), [home])
    assert.deepEqual(toolchainReadExceptions([target], [join(home, 'other')], []), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('protects relocated stores and canonical credential aliases while retaining managed caches', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'toolchain-relocated-stores-')))
  try {
    const data = join(home, 'data')
    const config = join(data, 'config')
    const profile = join(data, 'copse')
    const stores = [
      join(config, 'gh'),
      join(data, 'codex'),
      join(data, 'claude'),
      join(data, 'secure-storage'),
      join(data, 'cargo'),
      join(data, 'user-data'),
      join(data, 'conversations'),
    ]
    for (const path of stores) mkdirSync(path, { recursive: true })
    const env = {
      XDG_CONFIG_HOME: config,
      CODEX_HOME: stores[1],
      CLAUDE_CONFIG_DIR: stores[2],
      CLAUDE_SECURESTORAGE_CONFIG_DIR: stores[3],
      CARGO_HOME: stores[4],
      COPSE_DIR: profile,
      COPSE_PANEL_USER_DATA: stores[5],
      COPSE_WORKSPACE_DIR: stores[6],
    }
    const cache = join(profile, 'cache', 'corepack')
    mkdirSync(cache, { recursive: true })
    const target = join(home, 'otherwise-ordinary-cache')
    mkdirSync(target)
    symlinkSync(target, join(home, '.ssh'))
    const guard = createToolchainReadGuard(env, home)
    for (const path of [data, config, ...stores, target]) {
      assert.equal(guard(path, true), null, path)
    }
    assert.equal(guard(cache, true), cache)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('protects explicit known-tool credential locations and ambient host overrides', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'toolchain-explicit-credentials-')))
  const previousGithubConfig = process.env['GH_CONFIG_DIR']
  try {
    const store = join(home, 'relocated')
    const alias = join(home, 'runtime')
    const cache = join(home, 'safe-cache')
    mkdirSync(store)
    mkdirSync(cache)
    const file = join(store, 'private-data')
    writeFileSync(file, 'synthetic credential\n')
    symlinkSync(file, alias)
    for (const variable of [
      'GH_CONFIG_DIR',
      'DOCKER_CONFIG',
      'GNUPGHOME',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_CONFIG_FILE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'CLOUDSDK_CONFIG',
      'NPM_CONFIG_USERCONFIG',
      'npm_config_userconfig',
      'PIP_CONFIG_FILE',
    ]) {
      const guard = createToolchainReadGuard({ [variable]: file }, home)
      assert.equal(guard(alias, false), null, variable)
      assert.equal(guard(store, true), null, variable)
      assert.equal(guard(cache, true), cache, variable)
    }
    const kubeGuard = createToolchainReadGuard({ KUBECONFIG: `${file}${delimiter}${cache}` }, home)
    assert.equal(kubeGuard(alias, false), null)
    assert.equal(kubeGuard(cache, true), null, 'each KUBECONFIG entry is protected')
    process.env['GH_CONFIG_DIR'] = store
    assert.equal(createToolchainReadGuard({}, home)(alias, false), null)
  } finally {
    if (previousGithubConfig === undefined) delete process.env['GH_CONFIG_DIR']
    else process.env['GH_CONFIG_DIR'] = previousGithubConfig
    rmSync(home, { recursive: true, force: true })
  }
})

it('keeps a lexical exception only while every link it crosses stays out of sandbox reach', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'toolchain-lexical-exceptions-')))
  try {
    const install = join(home, '.local', 'share', 'fnm', 'installation')
    const workspace = join(home, 'projects', 'app')
    const agentState = join(home, '.cursor')
    for (const dir of [join(install, 'bin'), join(workspace, 'node_modules'), agentState]) {
      mkdirSync(dir, { recursive: true })
    }
    const multishell = join(home, '.local', 'state', 'fnm_multishells', '1234')
    mkdirSync(dirname(multishell), { recursive: true })
    symlinkSync(install, multishell)
    const fnm = [join(multishell, 'bin'), `${join(multishell, 'bin')}/**`]
    // The link lives in the denied home, where no contained command can write.
    assert.deepEqual(toolchainReadExceptions(fnm, [home], [workspace]), fnm)

    // A workspace link reached through a home alias: the spelling is outside
    // every read root, but a contained command could retarget the link.
    symlinkSync(workspace, join(home, 'app-alias'))
    symlinkSync(install, join(workspace, 'node_modules', 'planted'))
    const planted = [join(home, 'app-alias', 'node_modules', 'planted', 'bin')]
    assert.deepEqual(toolchainReadExceptions(planted, [home], []), planted)
    assert.deepEqual(toolchainReadExceptions(planted, [home], [workspace]), [])
    // So could an agent whose writable home dirs hold the link.
    symlinkSync(install, join(agentState, 'node'))
    const agent = [join(agentState, 'node', 'bin')]
    assert.deepEqual(toolchainReadExceptions(agent, [home], []), agent)
    assert.deepEqual(toolchainReadExceptions(agent, [home], [], [agentState]), [])
    assert.deepEqual(toolchainReadExceptions(agent, [home], [], [`${agentState}/**`]), [])

    // A spelling whose link cannot be inspected fails closed.
    rmSync(multishell)
    symlinkSync(join(home, 'missing'), multishell)
    assert.deepEqual(toolchainReadExceptions(fnm, [home], [workspace]), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('matches canonical toolchain exceptions against aliased home, temp and existing read roots', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'toolchain-aliased-read-roots-')))
  try {
    const home = join(parent, 'home')
    const homeAlias = join(parent, 'home-alias')
    const tools = join(home, '.volta', 'tools')
    mkdirSync(tools, { recursive: true })
    symlinkSync(home, homeAlias)
    const canonical = createToolchainReadGuard({}, homeAlias)(
      join(homeAlias, '.volta', 'tools'),
      true,
    )
    assert.equal(canonical, tools)
    assert.deepEqual(toolchainReadExceptions([tools, `${tools}/**`], [homeAlias], []), [
      tools,
      `${tools}/**`,
    ])
    const workspaceAlias = join(parent, 'workspace-alias')
    symlinkSync(tools, workspaceAlias)
    assert.deepEqual(
      toolchainReadExceptions([tools, `${tools}/**`], [homeAlias], [workspaceAlias]),
      [],
      'a canonical target already covered by an aliased workspace/cache needs no exception',
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
