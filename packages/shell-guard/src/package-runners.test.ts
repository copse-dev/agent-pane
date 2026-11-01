import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
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
  })

  it('is null for commands that are not a runner call', () => {
    for (const command of [
      'npm install',
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
