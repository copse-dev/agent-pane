import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const setup = readFileSync(resolve('.github/actions/setup/action.yml'), 'utf8')
const dockerfile = readFileSync(resolve('ci-runners/Dockerfile'), 'utf8')
const compose = readFileSync(resolve('ci-runners/docker-compose.yml'), 'utf8')
const entrypoint = readFileSync(resolve('ci-runners/entrypoint.sh'), 'utf8')
const remoteRun = readFileSync(resolve('ci-runners/exec-run.sh'), 'utf8')

function actionStep(name: string): string {
  const start = setup.indexOf(`    - name: ${name}\n`)
  assert.ok(start >= 0, `expected setup action step: ${name}`)
  const rest = setup.slice(start + 1)
  const next = rest.indexOf('\n    - name: ')
  return next >= 0 ? rest.slice(0, next) : rest
}

describe('CI dependency cache boundary', () => {
  it('caches package/download inputs but never an installed dependency tree', () => {
    const pnpmCache = actionStep('Restore pnpm content-addressed store')
    const runtimeCache = actionStep('Restore verified runtime downloads')
    for (const cache of [pnpmCache, runtimeCache]) {
      assert.match(cache, /uses: actions\/cache@v4/)
      assert.doesNotMatch(cache, /^\s+node_modules\/?$/m)
    }
    assert.match(pnpmCache, /pnpm-store-v1/)
    assert.match(runtimeCache, /runtime-inputs-v1/)
  })

  it('materializes a clean locked install on every job', () => {
    const install = actionStep('Install a clean dependency tree')
    assert.doesNotMatch(install, /^\s+if:/m)
    assert.match(install, /rm -rf node_modules/)
    assert.match(install, /pnpm install "\$\{args\[@\]\}"/)
    assert.match(install, /npm_config_ignore_scripts: 'false'/)
  })

  it('bakes only pnpm package inputs into the runner image', () => {
    const executable = dockerfile
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    assert.match(executable, /pnpm fetch --frozen-lockfile/)
    assert.doesNotMatch(executable, /pnpm install|COPSE_BAKED_DEPS/)
    assert.match(dockerfile, /ENTRYPOINT \["\/opt\/runner-template\/entrypoint\.sh"\]/)
  })

  it('does not mount a writable cross-job dependency volume', () => {
    assert.doesNotMatch(compose, /COPSE_DEPS_CACHE|deps-cache/)
    assert.equal(
      compose.match(/^\s+BUILD_GH_TOKEN: ''$/gm)?.length,
      2,
      'the build-only token must be blanked in both runtime services',
    )
    const checks = compose.slice(compose.indexOf('  runner-checks:'))
    assert.match(checks, /security_opt:\n\s+- seccomp=unconfined/)
    assert.match(checks, /- apparmor=unconfined/)
    assert.match(checks, /- systempaths=unconfined/)
  })
})

describe('self-hosted runner restart boundary', () => {
  it('restores trusted runner files and clears writable state before registration', () => {
    const reset = entrypoint.indexOf('find "$RUNNER_RUNTIME"')
    const restore = entrypoint.indexOf('cp -R "$RUNNER_TEMPLATE/."')
    const register = entrypoint.indexOf('./config.sh "${CONFIG_ARGS[@]}"')
    assert.ok(reset >= 0 && restore > reset && register > restore)
    assert.match(entrypoint, /find \/home\/runner/)
    assert.match(entrypoint, /find \/tmp \/var\/tmp/)
    assert.match(entrypoint, /EPHEMERAL must be true/)
    assert.match(entrypoint, /CONFIG_ARGS\+=\(--ephemeral\)/)
  })

  it('makes remote e2e install from package inputs instead of copying node_modules', () => {
    assert.match(remoteRun, /COPSE_BAKED_STORE/)
    assert.match(remoteRun, /pnpm install --frozen-lockfile/)
    assert.doesNotMatch(remoteRun, /COPSE_BAKED_DEPS|cp -a .*node_modules/)
  })
})
