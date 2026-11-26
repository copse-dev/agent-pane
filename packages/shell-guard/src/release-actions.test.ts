import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { releaseActionReasons } from './release-actions.ts'
import { assessShellHarm } from './shell-harm.ts'

const argv = (command: string): string[] => command.split(' ')
const reasons = (command: string): string[] => releaseActionReasons(argv(command))

describe('releaseActionReasons', () => {
  it('asks when a secret file is loaded into the shell', () => {
    assert.deepEqual(reasons('. ./.env.release'), [
      'loads a secret file into the shell (.env.release)',
    ])
    assert.deepEqual(reasons('source config/.env'), ['loads a secret file into the shell (.env)'])
    assert.deepEqual(reasons('if . ./.env.release'), [
      'loads a secret file into the shell (.env.release)',
    ])
    assert.deepEqual(reasons('source .env.example'), [])
    assert.deepEqual(reasons('source scripts/env.sh'), [])
  })

  it('asks for release, publish and deploy entry points', () => {
    for (const command of [
      'make ship-release VERSION=1.7.0',
      'make -C web deploy',
      'just release',
      'npm run release:mac',
      'pnpm run deploy',
      'yarn publish-site',
    ]) {
      assert.equal(reasons(command).length, 1, command)
    }
  })

  it('leaves builds, rehearsals and look-alike operands alone', () => {
    for (const command of [
      'make bundle-direct',
      'make -n release',
      'make release --dry-run',
      'pnpm run gen:api-protocol --released-ref v0.1.0',
      'pnpm deploy ./out',
      'npm publish',
      'make -f release.mk build',
    ]) {
      assert.deepEqual(reasons(command), [], command)
    }
  })

  it('asks for release signing but not for help', () => {
    assert.deepEqual(reasons('.build/bin/sign_update App.zip'), [
      'signs a release with a private key (sign_update)',
    ])
    assert.deepEqual(reasons('sign_update --help'), [])
    assert.equal(reasons('codesign --force --sign Developer App.app').length, 1)
    assert.deepEqual(reasons('codesign --verify --deep App.app'), [])
    assert.equal(reasons('gpg --detach-sign dist.tar.gz').length, 1)
    assert.equal(reasons('xcrun notarytool submit App.zip').length, 1)
    assert.equal(reasons('codesign -fs Developer App.app').length, 1)
    assert.deepEqual(reasons('codesign --sign - App.app'), [])
    assert.deepEqual(reasons('codesign -fs - App.app'), [])
    assert.equal(reasons('gpg -ab dist.tar.gz').length, 1)
    assert.deepEqual(reasons('gpg --verify dist.tar.gz.asc'), [])
  })

  it('asks when a tag is published or moved', () => {
    assert.deepEqual(reasons('git push origin refs/tags/v1.7.0'), [
      'publishes a release tag (git push refs/tags/v1.7.0)',
    ])
    assert.equal(reasons('git push origin v1.7.0').length, 1)
    assert.equal(reasons('git push --follow-tags origin main').length, 1)
    assert.equal(reasons('git -C /work/site push origin HEAD:v2.0.0-rc.1').length, 1)
    assert.deepEqual(reasons('git tag -f -a v1.7.0 -m x'), [
      'moves an existing tag (git tag --force)',
    ])
    for (const command of [
      'git push origin tag stable',
      'git push origin tags/stable',
      'git push origin HEAD:tags/stable',
      'git push --tag origin',
      'git push --follow-t origin main',
      'git push origin v1',
    ]) {
      assert.equal(reasons(command).length, 1, command)
    }
    for (const command of [
      'git push --mirror origin',
      'git push --prune origin main',
      'git push origin --delete old',
      'git push origin +main',
    ]) {
      assert.deepEqual(reasons(command), ['rewrites or deletes refs on the remote (git push)'], command)
    }
    assert.deepEqual(reasons('git push origin HEAD:copse/branch'), [])
    assert.deepEqual(reasons('git push origin feature/tag-names'), [])
    assert.deepEqual(reasons('git push --tag-option origin'), [])
    assert.deepEqual(reasons('git tag -a v1.7.0 -m x'), [])
  })

  it("asks when a command chooses git's credential helper", () => {
    assert.deepEqual(reasons('git -c credential.helper= push origin main'), [
      "overrides git's credentials or SSH command for this command",
    ])
    assert.deepEqual(reasons('git -c user.name=x commit -m y'), [])
    assert.equal(reasons('git --config-env=core.sshCommand=CMD push').length, 1)
    assert.equal(reasons('git -c include.path=/tmp/x fetch').length, 1)
    assert.deepEqual(reasons('git config core.sshCommand ssh-wrapper'), [
      'sets a git config key that runs a program (core.sshCommand)',
    ])
    assert.deepEqual(reasons('git config --get core.sshCommand'), [])
    assert.deepEqual(reasons('git config user.email a@b'), [])
  })
})

describe('releaseCommandReasons and secret copies', () => {
  it('asks when a secret file is fed in, copied, or a credential program is chosen', async () => {
    const { releaseCommandReasons } = await import('./release-actions.ts')
    assert.equal(releaseCommandReasons('base64 < .env').length, 1)
    assert.equal(releaseCommandReasons('while read l; do export "$l"; done < .env').length, 1)
    assert.equal(releaseCommandReasons('GIT_ASKPASS=/tmp/x git push').length, 1)
    assert.deepEqual(releaseCommandReasons('sort < data.txt'), [])
    assert.equal(reasons('cp .env /tmp/e').length, 1)
    assert.equal(reasons('tar czf out.tgz .env').length, 1)
    assert.deepEqual(reasons('cp .env.example .env'), [])
    assert.equal(reasons('ssh-add -D').length, 1)
    assert.equal(reasons('ssh-add').length, 1)
    assert.equal(reasons('cp -t /tmp .env').length, 1)
    assert.equal(reasons('cp --target-directory=/tmp .env').length, 1)
    assert.equal(releaseCommandReasons('GIT_CONFIG_COUNT=1 git push').length, 1)
    assert.deepEqual(reasons('ssh-add -l'), [])
    assert.equal(reasons('git -c core.sshCommand=ssh push').length, 1)
  })

  it('reads env behind another wrapper as printing the environment', () => {
    const context = { workspaceRoot: '/work/project', homeDir: '/Users/tester' }
    for (const command of [
      'nohup env | grep -i key',
      'timeout 60 env',
      'fnm exec --using=24 env',
    ]) {
      assert.equal(assessShellHarm(command, context).action, 'prompt', command)
    }
  })
})

describe('the harm gate', () => {
  const context = { workspaceRoot: '/work/project', homeDir: '/Users/tester' }

  it('asks for release work it used to allow', () => {
    for (const command of [
      "bash -c 'set -a; source ./.env.release; set +a; echo ok'",
      'make ship-release VERSION=1.7.0 > .build/ship.log 2>&1',
      "git tag -f -a v1.7.0 origin/main -m 'Release v1.7.0' && git push origin refs/tags/v1.7.0",
    ]) {
      assert.equal(assessShellHarm(command, context).action, 'prompt', command)
    }
  })

  it('still allows an ordinary build and branch push', () => {
    for (const command of ['make build > .build/release.log 2>&1', 'git push origin HEAD']) {
      assert.equal(assessShellHarm(command, context).action, 'allow', command)
    }
  })
})
