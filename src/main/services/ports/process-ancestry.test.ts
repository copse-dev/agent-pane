import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findOwner, parsePsPairs, attributePort, type PortOwner } from './process-ancestry.ts'

const shell: PortOwner = { kind: 'terminal', id: 'sess-1', label: 'Git Branch Switch' }
const task: PortOwner = { kind: 'background', id: 'task-1', label: 'npm run dev' }

describe('findOwner', () => {
  // node(12347) -> npm(12346) -> bash(12345, owned shell); init(1) unowned.
  const parents = new Map<number, number>([
    [12347, 12346],
    [12346, 12345],
    [12345, 1],
    [1, 0],
  ])
  const parentOf = (pid: number): number | null => parents.get(pid) ?? null
  const owned = new Map<number, PortOwner>([[12345, shell]])

  it('climbs from a grandchild to the owning shell', () => {
    assert.equal(findOwner(12347, parentOf, owned), shell)
  })

  it('matches the pid itself when it is the owned root', () => {
    assert.equal(findOwner(12345, parentOf, owned), shell)
  })

  it('returns null when no ancestor is owned', () => {
    assert.equal(findOwner(999, parentOf, owned), null)
  })

  it('does not loop forever on a cyclic parent map', () => {
    const cyclic = new Map<number, number>([
      [5, 6],
      [6, 5],
    ])
    assert.equal(
      findOwner(5, (p) => cyclic.get(p) ?? null, owned),
      null,
    )
  })
})

describe('parsePsPairs', () => {
  it('parses pid/ppid columns and skips junk', () => {
    const out = '  12345   1\n12346 12345\n\n  header text\n999 1\n'
    const map = parsePsPairs(out)
    assert.equal(map.get(12345), 1)
    assert.equal(map.get(12346), 12345)
    assert.equal(map.get(999), 1)
    assert.equal(map.size, 3)
  })
})

describe('attributePort', () => {
  const parents = new Map<number, number>([
    [200, 100],
    [100, 1],
  ])
  const owned = new Map<number, PortOwner>([[100, task]])

  it('attributes a descendant port to the background owner', () => {
    assert.equal(attributePort(200, parents, owned), task)
  })

  it('returns null for a null pid (unattributable scan row)', () => {
    assert.equal(attributePort(null, parents, owned), null)
  })

  it('returns null for a system process outside any owned tree', () => {
    assert.equal(attributePort(1, parents, owned), null)
  })
})
