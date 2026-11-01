import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  downloadingRunner,
  isPlainPackageName,
  packageBinName,
  packageManagerArgv,
  packageRunnerCall,
} from './package-runners.ts'

const call = (command: string): ReturnType<typeof packageRunnerCall> =>
  packageRunnerCall(command.split(' '))

describe('packageManagerArgv', () => {
  it('unwraps corepack, with or without a version pin on the manager', () => {
    for (const [command, expected] of [
      ['corepack pnpm exec evil', 'pnpm exec evil'],
      ['corepack pnpm@10.34.5 exec evil', 'pnpm exec evil'],
      ['corepack npm@11.0.0 exec evil', 'npm exec evil'],
      ['corepack yarn@4.5.0 dlx x', 'yarn dlx x'],
      ['corepack yarnpkg dlx x', 'yarn dlx x'],
      ['yarnpkg dlx x', 'yarn dlx x'],
      // `pnpx` is `pnpm dlx`: pnpm prints `Usage: pnpm dlx` for `pnpx --help`.
      ['pnpx evil', 'pnpm dlx evil'],
      ['corepack pnpx evil', 'pnpm dlx evil'],
      ['corepack enable', 'corepack enable'],
      ['pnpm exec tsc', 'pnpm exec tsc'],
    ]) {
      assert.deepEqual(packageManagerArgv((command ?? '').split(' ')), (expected ?? '').split(' '))
    }
  })

  it('drops the empty word shell-quote leaves for a backslash-newline', () => {
    assert.deepEqual(packageManagerArgv(['npx', '', 'evil']), ['npx', 'evil'])
  })
})

describe('downloadingRunner', () => {
  it('finds a downloading subcommand past global options', () => {
    for (const [command, expected] of new Map([
      ['pnpm dlx evil', 'pnpm dlx'],
      ['pnpm --silent dlx evil', 'pnpm dlx'],
      ['corepack pnpm --silent dlx evil', 'pnpm dlx'],
      ['pnpm -C sub dlx evil', 'pnpm dlx'],
      ['pnpx evil', 'pnpm dlx'],
      ['yarnpkg --cwd sub dlx evil', 'yarn dlx'],
      ['npm -s create vite', 'npm create'],
      ['npm cr vite', 'npm cr'],
      ['npm init --force vite', 'npm init'],
      ['bun --bun x cowsay', 'bun x'],
      ['bunx cowsay', 'bunx'],
    ])) {
      assert.equal(downloadingRunner(command.split(' ')), expected, command)
    }
  })

  it('leaves a subcommand that writes or runs local code alone', () => {
    for (const command of [
      'npm init -y',
      'npm -s init --yes',
      'npm run create',
      'pnpm run dlx',
      'pnpm --silent install',
      'pnpm exec evil',
      'npx evil',
    ]) {
      assert.equal(downloadingRunner(command.split(' ')), null, command)
    }
  })
})

describe('packageRunnerCall', () => {
  it('reads every spelling of npm exec, and npx', () => {
    for (const command of [
      'npx evil',
      'npm exec evil',
      'npm exe evil',
      'npm x evil',
      'npm -s exe evil',
      'corepack npm@11.0.0 exec evil',
    ]) {
      const result = call(command)
      assert.ok(result, command)
      assert.equal(result.fetches, true, command)
      assert.deepEqual(result.command, ['evil'], command)
      assert.equal(result.unmodelledOption, null, command)
    }
    assert.deepEqual(call('npm exec -- evil --flag')?.command, ['evil', '--flag'])
  })

  it('does not read pnpx as npx: it is pnpm dlx, which never runs a project binary', () => {
    assert.equal(call('pnpx evil'), null)
    assert.equal(call('corepack pnpx evil'), null)
  })

  it('reads pnpm exec, which runs a command from PATH rather than fetching', () => {
    for (const command of [
      'pnpm exec evil',
      'pnpm -s exec evil',
      'corepack pnpm@10.34.5 exec evil',
    ]) {
      const result = call(command)
      assert.ok(result, command)
      assert.equal(result.runner, 'pnpm exec', command)
      assert.equal(result.fetches, false, command)
      assert.deepEqual(result.command, ['evil'], command)
    }
    assert.equal(call('pnpm exec -c rm')?.shellMode, true)
  })

  it('records a package option and an option that may pick another binary', () => {
    assert.equal(call('npx -p cowsay cowsay hi')?.packageOption, 'cowsay')
    assert.equal(call('npx --package=cowsay cowsay')?.packageOption, 'cowsay')
    assert.equal(call('pnpm --filter app exec evil')?.unmodelledOption, '--filter')
    assert.equal(call('npm --prefix sub exec evil')?.unmodelledOption, '--prefix')
    assert.equal(call('pnpm exec -r evil')?.unmodelledOption, '-r')
    // An option between a value and the subcommand does not hide it.
    for (const command of [
      'npm --prefix /tmp --silent exec evil',
      'pnpm --filter app -s exec evil',
      'pnpm -C sub --silent exec evil',
    ]) {
      const result = call(command)
      assert.ok(result, command)
      assert.notEqual(result.unmodelledOption, null, command)
      assert.deepEqual(result.command, ['evil'], command)
    }
  })

  it('is null for commands that are not a runner call', () => {
    for (const command of [
      'npm install',
      // A word after an option that takes no value, or after `--opt=value`, is the subcommand.
      'npm --silent install exec',
      'npm --prefix=/tmp install exec',
      'npm run exec',
      'pnpm add exec',
      'pnpm test',
      'yarn evil',
    ]) {
      assert.equal(call(command), null, command)
    }
  })
})

describe('package names', () => {
  it('accepts a plain or scoped name and maps it to its .bin entry', () => {
    assert.equal(isPlainPackageName('tsc'), true)
    assert.equal(isPlainPackageName('@scope/tool'), true)
    for (const name of ['./tool', 'tsc@5', 'github:x/y', '']) {
      assert.equal(isPlainPackageName(name), false, name)
    }
    assert.equal(packageBinName('@scope/tool'), 'tool')
    assert.equal(packageBinName('eslint'), 'eslint')
  })
})
