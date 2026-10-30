import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'

const cli = resolve('scripts/check-e2e-release-waivers.mts')

it('imports without reading the registry, running gh or terminating the process', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-waiver-import-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(cli).href)}); console.log('imported')`,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'imported\n')
    assert.equal(result.stderr, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('runs directly without dependencies and fails closed for pending real ownership and acceptance', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-waiver-cli-'))
  try {
    mkdirSync(join(root, 'tests/e2e'), { recursive: true })
    const file = join(root, 'tests/e2e/exclusions.json')
    writeFileSync(file, readFileSync('tests/e2e/exclusions.json'))
    const rejected = spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8' })
    assert.equal(rejected.status, 1, rejected.stderr)
    assert.match(rejected.stderr, /Unaccepted quarantine requires restoration/)
    assert.match(rejected.stdout, /quarantine:/)
    writeFileSync(file, JSON.stringify({ version: 2, entries: [] }))
    const accepted = spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /every quarantine has a current owner-reviewed waiver/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('checks expiry on the candidate at tagging, signing and manual publication', () => {
  for (const name of ['release-cut', 'release-mac', 'release-publish']) {
    const text = readFileSync(`.github/workflows/${name}.yml`, 'utf8')
    assert.match(text, /node scripts\/check-e2e-release-waivers\.mts/)
    assert.match(text, /issues: read/)
    assert.match(text, /pull-requests: read/)
  }
  const cut = readFileSync('.github/workflows/release-cut.yml', 'utf8')
  assert.ok(
    cut.indexOf('node scripts/check-e2e-release-waivers.mts') <
      cut.indexOf('await github.rest.git.createRef'),
  )
  const publication = readFileSync('.github/workflows/release-publish.yml', 'utf8')
  assert.ok(
    publication.indexOf('GH_TOKEN="$SOURCE_GH_TOKEN" node scripts/check-e2e-release-waivers.mts') <
      publication.indexOf('name: Record the release in the release repository'),
  )
})
