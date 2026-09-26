import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inertOperandIndexes } from './inert-operands.ts'

const inert = (...argv: string[]): number[] => [...inertOperandIndexes(argv)].sort()

describe('inertOperandIndexes', () => {
  it('finds the pattern operand of grep and rg', () => {
    assert.deepEqual(inert('grep', '-rn', '/usr/local/bin', 'src'), [2])
    assert.deepEqual(inert('grep', '-v', '//'), [2])
    assert.deepEqual(inert('rg', '-n', '--hidden', '/etc/hosts', 'src'), [3])
    assert.deepEqual(inert('grep', '-A', '3', '/x', 'src'), [3])
    assert.deepEqual(inert('grep', '-rnA3', '/x', 'src'), [2])
    assert.deepEqual(inert('grep', '--', '-/x', 'src'), [2])
    assert.deepEqual(inert('/usr/bin/grep', '/x', 'src'), [1])
  })

  it('finds -e and --regexp patterns and treats every positional as a file', () => {
    assert.deepEqual(inert('grep', '-e', '/x', '-e', '/y', '/etc/hosts'), [2, 4])
    assert.deepEqual(inert('grep', '-rne', '/x', 'src'), [2])
    assert.deepEqual(inert('rg', '--regexp', '/x', '/etc'), [2])
    assert.deepEqual(inert('grep', '-e/x', '/etc/hosts'), [])
    assert.deepEqual(inert('grep', '--regexp=/x', '/etc/hosts'), [])
  })

  it('finds nothing when patterns come from a file or there is no pattern', () => {
    assert.deepEqual(inert('grep', '-f', '/etc/patterns', 'src'), [])
    assert.deepEqual(inert('grep', '--file=/etc/patterns', 'src'), [])
    assert.deepEqual(inert('rg', '--files', '/etc'), [])
    assert.deepEqual(inert('grep'), [])
  })

  it('finds nothing when any flag is not understood', () => {
    // Treating an unknown value-taking flag as a switch would read its value as
    // the pattern and hide a real operand.
    assert.deepEqual(inert('rg', '--frobnicate', '/tmp/tool', 'TODO', 'src'), [])
    assert.deepEqual(inert('grep', '-y', '/x', 'src'), [])
    assert.deepEqual(inert('grep', '--count=3', '/x', 'src'), [])
  })

  it('never treats a flag value as a pattern', () => {
    assert.deepEqual(inert('rg', '--pre', '/tmp/tool', 'TODO', 'src'), [3])
    assert.deepEqual(inert('rg', '-g', '/etc/*', 'TODO'), [3])
  })

  it('reads BSD grep --context as taking no separate value', () => {
    assert.deepEqual(inert('grep', '--context', '/x', 'src'), [2])
  })

  it('finds the script of a read-only sed, and nothing in any other sed', () => {
    assert.deepEqual(inert('sed', '-n', '/^## /p', 'notes.md'), [2])
    assert.deepEqual(inert('sed', '-n', '-e', '1,5p', '-e', '/x/p', 'a'), [3, 5])
    assert.deepEqual(inert('sed', '-ne', '/x/p', 'a'), [2])
    assert.deepEqual(inert('sed', '-e/x/p', 'a'), [])
    assert.deepEqual(inert('sed', '-i', '/x/d', 'a'), [])
    assert.deepEqual(inert('sed', '-n', 'w /tmp/out', 'a'), [])
  })

  it('ignores other programs', () => {
    assert.deepEqual(inert('cat', '/etc/hosts'), [])
    assert.deepEqual(inert('sed', '-n', 's|/etc|x|p', 'a'), [])
    assert.deepEqual(inert('echo', '/x'), [])
  })
})
