import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findNoticeProblems,
  needsNoticeEntry,
  parseNotices,
  type ShippedComponent,
} from './third-party-notices.mts'

const NOTICES = `# Third-party notices

## Copse interface fonts

- **License:** SIL Open Font License 1.1.

## noVNC (@novnc/novnc)

- **License:** MPL-2.0
- **Modifications:** none. Version 1.7.0 is bundled as published.

## Forge (node-forge)

- **License:** \`(BSD-3-Clause OR GPL-2.0)\`. Copse elects the BSD-3-Clause option.
- **Modifications:** none. Version 1.4.0 is shipped as published.

## Not shipped: sharp and libvips (sharp, @img/sharp-libvips-*)

Neither ships.
`

const SHIPPED: ShippedComponent[] = [
  { name: '@novnc/novnc', version: '1.7.0', license: 'MPL-2.0' },
  { name: 'node-forge', version: '1.4.0', license: '(BSD-3-Clause OR GPL-2.0)' },
  { name: 'zod', version: '4.6.5', license: 'MIT' },
]

function problemsFor(
  components: ShippedComponent[],
  markdown = NOTICES,
  complete = true,
): string[] {
  return findNoticeProblems(parseNotices(markdown), components, { complete }).map(
    ({ subject, problem }) => `${subject}: ${problem}`,
  )
}

describe('parseNotices', () => {
  it('reads entries, quoted versions and not-shipped claims, and skips prose headings', () => {
    const parsed = parseNotices(NOTICES)
    assert.deepEqual(
      parsed.entries.map(({ packageName, version }) => [packageName, version]),
      [
        ['@novnc/novnc', '1.7.0'],
        ['node-forge', '1.4.0'],
      ],
    )
    assert.deepEqual(parsed.notShipped, [
      {
        heading: 'Not shipped: sharp and libvips (sharp, @img/sharp-libvips-*)',
        patterns: ['sharp', '@img/sharp-libvips-*'],
      },
    ])
  })

  it('does not treat a parenthetical that is not a package name as an entry', () => {
    assert.deepEqual(parseNotices('## Fonts (bundled as published)\n').entries, [])
  })
})

describe('needsNoticeEntry', () => {
  it('lets attribution-only licences through', () => {
    for (const license of ['MIT', 'Apache-2.0', 'BlueOak-1.0.0', 'Python-2.0', 'MIT AND ISC']) {
      assert.equal(needsNoticeEntry(license), false, license)
    }
  })

  it('flags copyleft, unknown and dual licences', () => {
    for (const license of [
      'MPL-2.0',
      'LGPL-3.0-or-later',
      'CC-BY-4.0',
      'UNKNOWN',
      '(MPL-2.0 OR Apache-2.0)',
      '(BSD-3-Clause OR GPL-2.0)',
    ]) {
      assert.equal(needsNoticeEntry(license), true, license)
    }
  })
})

describe('findNoticeProblems', () => {
  it('passes when the notices match what ships', () => {
    assert.deepEqual(problemsFor(SHIPPED), [])
  })

  it('flags a newly shipped component that needs an entry', () => {
    const problems = problemsFor([
      ...SHIPPED,
      { name: 'dompurify', version: '3.4.13', license: '(MPL-2.0 OR Apache-2.0)' },
    ])
    assert.equal(problems.length, 1)
    assert.match(problems[0] ?? '', /^dompurify@3\.4\.13: .*no "## … \(dompurify\)" entry/)
  })

  it('flags a version the entry no longer matches', () => {
    const problems = problemsFor([
      { name: '@novnc/novnc', version: '1.8.0', license: 'MPL-2.0' },
      ...SHIPPED.slice(1),
    ])
    assert.deepEqual(problems, ['@novnc/novnc: entry says version 1.7.0, but 1.8.0 ships'])
  })

  it('flags an entry for a component that no longer ships, only when the set is complete', () => {
    const withoutNoVnc = SHIPPED.slice(1)
    assert.deepEqual(problemsFor(withoutNoVnc), [
      '@novnc/novnc: has an entry ("## noVNC (@novnc/novnc)") but no longer ships',
    ])
    assert.deepEqual(problemsFor(withoutNoVnc, NOTICES, false), [])
  })

  it('flags a "not shipped" claim that has stopped being true, by name and by prefix', () => {
    const problems = problemsFor([
      ...SHIPPED,
      { name: 'sharp', version: '0.35.4', license: 'Apache-2.0' },
      { name: '@img/sharp-libvips-darwin-arm64', version: '1.3.3', license: 'LGPL-3.0-or-later' },
    ])
    assert.ok(
      problems.includes(
        'sharp@0.35.4: ships, but "## Not shipped: sharp and libvips (sharp, @img/sharp-libvips-*)" says it does not',
      ),
    )
    assert.ok(
      problems.some((p) => p.startsWith('@img/sharp-libvips-darwin-arm64@1.3.3: ships, but')),
    )
  })

  it('requires a dual-licensed entry to record the election', () => {
    const markdown = NOTICES.replace('Copse elects the BSD-3-Clause option.', '')
    assert.deepEqual(problemsFor(SHIPPED, markdown), [
      'node-forge@1.4.0: is dual-licensed ((BSD-3-Clause OR GPL-2.0)); its entry must say which licence Copse elects',
    ])
  })
})
