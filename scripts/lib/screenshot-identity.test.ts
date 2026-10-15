import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  buildIdentityRecords,
  canonicalJson,
  environmentFromRunner,
  identityHash,
  INPUT_CLASSES,
  parseIdentityRecords,
  parseShard,
  provenanceFromRunner,
  renderingInputs,
  serializeIdentityRecords,
  sha256Hex,
  type BuildIdentityInput,
  type IdentityRecords,
  type IdentityTree,
  type RenderingEnvironment,
  type RenderingProvenance,
} from './screenshot-identity.mts'

/** A small repository shaped like the real one, held in memory. */
function baseFiles(): Record<string, string> {
  return {
    'package.json': '{"name":"copse-panel"}',
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    '.nvmrc': '24.20.0',
    'tsconfig.web.json': '{}',
    'wdio.conf.ts': 'export const config = { args: ["--force-device-scale-factor=2"] }',
    'wdio.ci.conf.ts': "export { config } from './wdio.conf.ts'",
    'scripts/run-e2e.mts': 'xvfb-run --server-args=-screen 0 3200x2048x24',
    'scripts/build.mts': 'esbuild',
    'tests/e2e/helpers/screenshot.ts': 'export const E2E_VIEWPORT = { width: 1280, height: 800 }',
    'tests/e2e/helpers/seed-config.ts':
      "export const seed = 1\nexport const SHELL = 'tests/e2e/fixtures/e2e-bash-shell.sh'",
    'tests/e2e/helpers/unused.ts': 'export const nothing = true',
    'tests/e2e/electron-shell/bootstrap.cjs': 'require("electron")',
    'tests/e2e/electron-shell/.e2e-env.json': '{"runtime":"state"}',
    'tests/e2e/fixtures/e2e-bash-shell.sh': '#!/bin/sh',
    'tests/e2e/fixtures/git-changes-red.png': 'png-red',
    'tests/fixtures/mock-acp-agent.mjs': 'agent',
    'tests/fixtures/agent-dir/one.txt': 'one',
    'tests/fixtures/agent-dir/two.txt': 'two',
    'tests/e2e/settings.e2e.ts': [
      "import { seed } from './helpers/seed-config.ts'",
      "import { saveAppScreenshot } from './helpers/screenshot.ts'",
      "import { join } from 'node:path'",
      "const red = join(process.cwd(), 'tests/e2e/fixtures/git-changes-red.png')",
      "const agents = join(process.cwd(), 'tests/fixtures/agent-dir')",
      "await $('#settings-panel .provider-row')",
      "await saveAppScreenshot('settings-panel.png')",
      "await saveAppScreenshot('settings-providers.png')",
    ].join('\n'),
    'tests/e2e/footer.e2e.ts': [
      "import { saveAppScreenshot } from './helpers/screenshot.ts'",
      "await $('.footer-status')",
      "await saveAppScreenshot('footer.png')",
    ].join('\n'),
    'tests/e2e/screenshots/manifest.json': '{"version":1,"screenshots":{}}',
    'src/renderer/index.html': '<div id="app"></div>',
    'src/renderer/main.ts': "import './views/settings.ts'",
    'src/renderer/styles/tokens.css': "@font-face { src: url('../../../assets/fonts/Pliant.ttf') }",
    'src/renderer/views/settings.ts': "el.id = 'settings-panel'; row.className = 'provider-row'",
    'src/renderer/views/footer.ts': "el.className = 'footer-status'",
    'src/renderer/views/unrelated.ts': 'export const unrelated = 1',
    'src/renderer/views/settings.test.ts': "it('settings-panel', () => {})",
    'src/shared/util.ts': 'export const util = 1',
    'assets/fonts/Pliant.ttf': 'font-bytes',
    'assets/icons/rose/icon-32.png': 'icon-bytes',
  }
}

function memoryTree(files: Record<string, string>): IdentityTree {
  return {
    paths: (dir) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .sort(),
    read: (path) => files[path] ?? '',
    exists: (path) =>
      Object.hasOwn(files, path) || Object.keys(files).some((f) => f.startsWith(`${path}/`)),
    isFile: (path) => Object.hasOwn(files, path),
  }
}

const environment: RenderingEnvironment = {
  electron: '44.5.1',
  chromium: '152.0.7977.65',
  node: 'v24.20.0',
  os: 'Linux',
  arch: 'X64',
  image: 'ubuntu24/20261001.1',
  headless: '0',
  timezone: 'UTC',
  systemFonts: 'f'.repeat(64),
}

const provenance: RenderingProvenance = {
  repository: 'copse-dev/agent-pane',
  run: '31900000001',
  attempt: '1',
  job: 'e2e',
  event: 'pull_request',
  shard: '3/8',
  checkout: 'a'.repeat(40),
  head: 'b'.repeat(40),
  base: 'c'.repeat(40),
  runner: { name: 'GitHub Actions 12', environment: 'github-hosted' },
}

const MARKER_MS = 1_000_000
const SPECS = ['tests/e2e/settings.e2e.ts', 'tests/e2e/footer.e2e.ts']

type Scenario = {
  files?: Record<string, string>
  pngs?: Record<string, { bytes: string; mtimeMs: number }>
  environment?: RenderingEnvironment
  provenance?: RenderingProvenance
  markerMs?: number | null
  specs?: string[]
  baselineNames?: string[]
}

function build(scenario: Scenario = {}): IdentityRecords {
  const files = scenario.files ?? baseFiles()
  const pngs = scenario.pngs ?? {
    'settings-panel.png': { bytes: 'panel-v1', mtimeMs: MARKER_MS + 5_000 },
    'settings-providers.png': { bytes: 'providers-v1', mtimeMs: MARKER_MS - 5_000 },
    'footer.png': { bytes: 'footer-v1', mtimeMs: MARKER_MS + 9_000 },
    'unmapped.png': { bytes: 'baseline', mtimeMs: MARKER_MS - 60_000 },
  }
  const input: BuildIdentityInput = {
    tree: memoryTree(files),
    specs: scenario.specs ?? SPECS,
    environment: scenario.environment ?? environment,
    provenance: scenario.provenance ?? provenance,
    hashFile: (path) => {
      const body = files[path]
      if (body === undefined) throw new Error(`missing ${path}`)
      return sha256Hex(body)
    },
    screenshot: (name) => {
      const png = pngs[name]
      return png ? { bytes: Buffer.from(png.bytes), mtimeMs: png.mtimeMs } : null
    },
    baselineNames: scenario.baselineNames ?? [...Object.keys(pngs), 'absent.png'],
    markerMs: scenario.markerMs === undefined ? MARKER_MS : scenario.markerMs,
  }
  return buildIdentityRecords(input)
}

function record(records: IdentityRecords, name: string): IdentityRecords['records'][number] {
  const found = records.records.find((entry) => entry.name === name)
  assert.ok(found, `no record for ${name}`)
  return found
}

function identityOf(scenario: Scenario, name = 'settings-panel.png'): string {
  return record(build(scenario), name).identity
}

function withFile(path: string, body: string): Record<string, string> {
  return { ...baseFiles(), [path]: body }
}

describe('rendering inputs', () => {
  it('groups the oracle mapping into disjoint classes', () => {
    const inputs = renderingInputs('tests/e2e/settings.e2e.ts', memoryTree(baseFiles()))
    assert.deepEqual(inputs.spec, [
      'tests/e2e/helpers/screenshot.ts',
      'tests/e2e/helpers/seed-config.ts',
      'tests/e2e/settings.e2e.ts',
    ])
    assert.deepEqual(inputs.fixtures, [
      'tests/e2e/fixtures/e2e-bash-shell.sh',
      'tests/e2e/fixtures/git-changes-red.png',
      'tests/fixtures/agent-dir/one.txt',
      'tests/fixtures/agent-dir/two.txt',
    ])
    assert.deepEqual(inputs.assets, ['assets/fonts/Pliant.ttf', 'assets/icons/rose/icon-32.png'])
    assert.deepEqual(inputs.dependencies, [
      '.nvmrc',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.web.json',
    ])
    assert.deepEqual(inputs.capture, [
      'scripts/build.mts',
      'scripts/run-e2e.mts',
      'tests/e2e/electron-shell/bootstrap.cjs',
      'tests/e2e/helpers/unused.ts',
      'wdio.ci.conf.ts',
      'wdio.conf.ts',
    ])
    // Broad renderer globals plus the files holding the spec's selectors; the
    // unrelated view and the unit test beside it are not inputs.
    assert.deepEqual(inputs.renderer, [
      'src/renderer/index.html',
      'src/renderer/main.ts',
      'src/renderer/styles/tokens.css',
      'src/renderer/views/settings.ts',
    ])
    const all = INPUT_CLASSES.flatMap((cls) => inputs[cls])
    assert.equal(new Set(all).size, all.length, 'a path belongs to exactly one class')
    assert.ok(!all.includes('tests/e2e/electron-shell/.e2e-env.json'), 'runtime state excluded')
    assert.ok(!all.includes('tests/e2e/screenshots/manifest.json'), 'the baseline is an output')
  })

  it('rejects a path that is not an e2e spec', () => {
    assert.throws(
      () => renderingInputs('src/renderer/main.ts', memoryTree(baseFiles())),
      /Not an e2e spec path/,
    )
  })
})

describe('identity hash', () => {
  it('is deterministic and independent of key order', () => {
    const a = build()
    const b = build()
    assert.equal(record(a, 'settings-panel.png').identity, record(b, 'settings-panel.png').identity)
    assert.equal(
      canonicalJson({ z: 1, a: [{ y: 2, x: 1 }], m: undefined }),
      '{"a":[{"x":1,"y":2}],"z":1}',
    )
    const entry = record(a, 'footer.png')
    const reordered = {
      ...entry,
      inputs: Object.fromEntries(Object.entries(entry.inputs).reverse()),
    }
    assert.equal(
      identityHash({ name: entry.name, spec: entry.spec, inputs: entry.inputs }, a.files, {
        ...environment,
      }),
      entry.identity,
    )
    assert.equal(
      identityHash({ ...entry, inputs: entry.inputs }, a.files, environment),
      entry.identity,
    )
    assert.equal(reordered.name, entry.name)
  })

  it('differs between screenshots of one spec and between specs', () => {
    const records = build()
    const identities = records.records.map((entry) => entry.identity)
    assert.equal(new Set(identities).size, identities.length)
    assert.deepEqual(
      records.records.map((entry) => entry.name),
      ['footer.png', 'settings-panel.png', 'settings-providers.png'],
    )
  })

  it('does not change with the rendered bytes or the provenance', () => {
    const base = identityOf({})
    assert.equal(
      identityOf({
        pngs: { 'settings-panel.png': { bytes: 'panel-v2', mtimeMs: MARKER_MS + 1 } },
      }),
      base,
    )
    assert.equal(
      identityOf({
        provenance: { ...provenance, run: '31900000002', shard: '1/1', head: 'd'.repeat(40) },
      }),
      base,
    )
  })

  const negatives: [label: string, scenario: Scenario][] = [
    [
      'the spec itself',
      {
        files: withFile(
          'tests/e2e/settings.e2e.ts',
          `${baseFiles()['tests/e2e/settings.e2e.ts'] ?? ''}\n// settled-state wait added`,
        ),
      },
    ],
    [
      'a helper the spec imports',
      { files: withFile('tests/e2e/helpers/seed-config.ts', 'export const seed = 2') },
    ],
    [
      'a fixture the spec names',
      { files: withFile('tests/e2e/fixtures/git-changes-red.png', 'png-red-v2') },
    ],
    [
      'a fixture under a directory the spec names',
      { files: withFile('tests/fixtures/agent-dir/two.txt', 'two-v2') },
    ],
    [
      'renderer source holding one of the spec selectors',
      { files: withFile('src/renderer/views/settings.ts', "el.id = 'settings-panel'; // v2") },
    ],
    ['a broad renderer global', { files: withFile('src/renderer/index.html', '<div id="app2">') }],
    ['a font asset', { files: withFile('assets/fonts/Pliant.ttf', 'font-bytes-v2') }],
    ['the lockfile', { files: withFile('pnpm-lock.yaml', 'lockfileVersion: 10') }],
    [
      'the capture helpers',
      {
        files: withFile(
          'tests/e2e/helpers/screenshot.ts',
          'export const E2E_VIEWPORT = { width: 1600, height: 800 }',
        ),
      },
    ],
    ['the wdio configuration', { files: withFile('wdio.conf.ts', 'scale-factor=1') }],
    ['the e2e launcher geometry', { files: withFile('scripts/run-e2e.mts', '1600x1024x24') }],
    ['the Electron version', { environment: { ...environment, electron: '44.5.2' } }],
    ['the Chromium version', { environment: { ...environment, chromium: '152.0.7977.66' } }],
    ['the runner image', { environment: { ...environment, image: 'ubuntu24/20261008.1' } }],
    ['the system fonts', { environment: { ...environment, systemFonts: 'e'.repeat(64) } }],
    ['the headless mode', { environment: { ...environment, headless: '1' } }],
    ['the timezone', { environment: { ...environment, timezone: 'Europe/London' } }],
  ]
  for (const [label, scenario] of negatives) {
    it(`changes when ${label} changes`, () => {
      assert.notEqual(identityOf(scenario), identityOf({}))
    })
  }

  it('ignores renderer source the oracle does not map to the spec', () => {
    assert.equal(
      identityOf({
        files: withFile('src/renderer/views/unrelated.ts', 'export const unrelated = 2'),
      }),
      identityOf({}),
    )
    assert.equal(
      identityOf({
        files: withFile('src/renderer/views/footer.ts', "el.className = 'footer-status-2'"),
      }),
      identityOf({}),
    )
    assert.notEqual(
      identityOf(
        { files: withFile('src/renderer/views/footer.ts', "el.className = 'footer-status-2'") },
        'footer.png',
      ),
      identityOf({}, 'footer.png'),
    )
  })

  it('ignores a new file the mapping never reaches', () => {
    assert.equal(
      identityOf({ files: withFile('src/main/services/worker.ts', 'export const w = 1') }),
      identityOf({}),
    )
  })
})

describe('rendered marker', () => {
  it('retains valid rendered flags for audited real settings continuation writes', () => {
    const spec = 'tests/e2e/settings-provider-hosts.e2e.ts'
    const files = { ...baseFiles(), [spec]: readFileSync(spec, 'utf8') }
    const pngs = {
      'settings-provider-hosts-page-2.png': { bytes: 'page-two', mtimeMs: MARKER_MS + 1 },
    }
    const records = build({ files, specs: [spec], pngs })
    assert.equal(records.marker, 'valid')
    assert.equal(record(records, 'settings-provider-hosts-page-2.png').result?.rendered, true)
    const unknown = build({
      files,
      specs: [spec],
      pngs: { ...pngs, 'unknown.png': { bytes: 'late', mtimeMs: MARKER_MS + 1 } },
    })
    assert.equal(unknown.marker, 'invalidated')
    assert.equal(record(unknown, 'settings-provider-hosts-page-2.png').result?.rendered, null)
  })
  it('marks PNGs written after the marker as rendered', () => {
    const records = build()
    assert.equal(records.marker, 'valid')
    assert.deepEqual(record(records, 'settings-panel.png').result, {
      sha256: sha256Hex('panel-v1'),
      bytes: 8,
      rendered: true,
    })
    assert.equal(record(records, 'settings-providers.png').result?.rendered, false)
    assert.equal(record(records, 'footer.png').result?.rendered, true)
  })

  it('records a missing PNG as a null result', () => {
    const records = build({ pngs: { 'footer.png': { bytes: 'footer', mtimeMs: MARKER_MS + 1 } } })
    assert.equal(record(records, 'settings-panel.png').result, null)
    assert.equal(record(records, 'footer.png').result?.rendered, true)
  })

  it('cannot tell rendered from restored without a marker', () => {
    const records = build({ markerMs: null })
    assert.equal(records.marker, 'missing')
    for (const entry of records.records) assert.equal(entry.result?.rendered ?? null, null)
  })

  it('invalidates the marker when an unowned PNG is newer than it', () => {
    const records = build({
      pngs: {
        'settings-panel.png': { bytes: 'panel-v1', mtimeMs: MARKER_MS + 5_000 },
        'unmapped.png': { bytes: 'restored-late', mtimeMs: MARKER_MS + 1 },
      },
    })
    assert.equal(records.marker, 'invalidated')
    assert.equal(record(records, 'settings-panel.png').result?.rendered, null)
    assert.equal(record(records, 'settings-panel.png').result?.sha256, sha256Hex('panel-v1'))
  })

  it('refuses two specs that write the same screenshot', () => {
    assert.throws(
      () =>
        build({
          files: withFile(
            'tests/e2e/footer.e2e.ts',
            "import { saveAppScreenshot } from './helpers/screenshot.ts'\nawait saveAppScreenshot('settings-panel.png')",
          ),
        }),
      /written by both/,
    )
  })
})

describe('record decoding', () => {
  function mutate(edit: (records: IdentityRecords) => unknown): string {
    const records = parseIdentityRecords(serializeIdentityRecords(build()))
    const replaced = edit(records)
    return JSON.stringify(replaced === undefined ? records : replaced)
  }

  it('round-trips a serialized record set', () => {
    const records = build()
    const text = serializeIdentityRecords(records)
    assert.deepEqual(parseIdentityRecords(text), records)
    assert.equal(serializeIdentityRecords(parseIdentityRecords(text)), text)
  })

  function rejects(label: string, edit: (records: IdentityRecords) => unknown): void {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseIdentityRecords(mutate(edit)), /Invalid screenshot identity records/)
    })
  }
  it('rejects text that is not JSON', () => {
    assert.throws(() => parseIdentityRecords('{'), /Invalid screenshot identity records/)
  })
  rejects('missing provenance', ({ provenance: _omitted, ...rest }) => rest)
  rejects('a provenance field that is not a commit', (r) => {
    r.provenance.head = 'HEAD'
  })
  rejects('a short run id', (r) => {
    r.provenance.run = '0'
  })
  rejects('a shard index past its total', (r) => {
    r.provenance.shard = '9/8'
  })
  rejects('a provenance field left blank', (r) => {
    r.provenance.runner.name = ' '
  })
  rejects('an unknown provenance field', (r) => ({
    ...r,
    provenance: { ...r.provenance, token: 'x' },
  }))
  rejects('a missing environment field', ({ environment: env, ...rest }) => {
    const { chromium: _omitted, ...partial } = env
    return { ...rest, environment: partial }
  })
  rejects('an unknown marker state', (r) => ({ ...r, marker: 'guessed' }))
  rejects('a tampered identity', (r) => {
    const entry = r.records[0]
    if (entry) entry.identity = 'd'.repeat(64)
  })
  rejects('a tampered input hash', (r) => {
    r.files['tests/e2e/settings.e2e.ts'] = 'd'.repeat(64)
  })
  rejects('a tampered environment', (r) => {
    r.environment.chromium = '152.0.7977.99'
  })
  rejects('an input with no hash', (r) => {
    r.records[0]?.inputs.renderer.push('src/renderer/zzz.ts')
  })
  rejects('an input listed in two classes', (r) => {
    const entry = r.records[0]
    if (entry) entry.inputs.renderer.push(entry.spec)
  })
  rejects('a spec missing from its own inputs', (r) => {
    const entry = r.records[1]
    if (entry) entry.inputs.spec = []
  })
  rejects('a duplicate screenshot name', (r) => {
    const entry = r.records[0]
    if (entry) r.records.push({ ...entry })
  })
  rejects('a result with a bad hash', (r) => {
    const result = r.records[0]?.result
    if (result) result.sha256 = 'nope'
  })
  rejects('an extra record field', (r) => ({
    ...r,
    records: r.records.map((entry) => ({ ...entry, note: 'x' })),
  }))
  rejects('a path escaping the repository', (r) => {
    r.files['../etc/passwd'] = 'd'.repeat(64)
    r.records[0]?.inputs.fixtures.push('../etc/passwd')
  })
  rejects('another version', (r) => ({ ...r, version: 2 }))

  it('rejects unsorted inputs because they would not hash canonically', () => {
    const text = mutate((r) => {
      const entry = r.records[0]
      if (entry) entry.inputs.spec = [...entry.inputs.spec].reverse()
    })
    assert.throws(() => parseIdentityRecords(text), /unsorted|identity mismatch/)
  })
})

describe('runner metadata', () => {
  it('parses shard coordinates', () => {
    assert.deepEqual(parseShard('3/8'), { index: 3, total: 8 })
    assert.deepEqual(parseShard('1/1'), { index: 1, total: 1 })
    for (const bad of ['0/8', '9/8', '3', '3/08', 'a/b', '']) assert.equal(parseShard(bad), null)
  })

  it('reads the hosted image and falls back to an unknown self-hosted image', () => {
    const versions = {
      electron: '44.5.1',
      chromium: '152.0.7977.65',
      node: 'v24.20.0',
      systemFonts: 'f'.repeat(64),
    }
    const hosted = environmentFromRunner(
      {
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_ENVIRONMENT: 'github-hosted',
        ImageOS: 'ubuntu24',
        ImageVersion: '20261001.1',
        COPSE_E2E_HEADLESS: '0',
        TZ: 'UTC',
      },
      versions,
    )
    assert.equal(hosted.image, 'ubuntu24/20261001.1')
    assert.equal(hosted.headless, '0')
    const selfHosted = environmentFromRunner(
      { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', RUNNER_ENVIRONMENT: 'self-hosted' },
      versions,
    )
    assert.equal(selfHosted.image, 'self-hosted:unknown-image')
    assert.equal(selfHosted.headless, 'unset')
    assert.equal(selfHosted.timezone, 'unset')
    assert.notEqual(
      identityHash(
        { name: 'a.png', spec: 'tests/e2e/a.e2e.ts', inputs: emptyInputs() },
        {},
        hosted,
      ),
      identityHash(
        { name: 'a.png', spec: 'tests/e2e/a.e2e.ts', inputs: emptyInputs() },
        {},
        selfHosted,
      ),
    )
  })

  it('refuses to invent provenance for a run outside Actions', () => {
    const env = {
      GITHUB_REPOSITORY: 'copse-dev/agent-pane',
      GITHUB_RUN_ID: '31900000001',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: 'e2e',
      GITHUB_EVENT_NAME: 'pull_request',
      RUNNER_NAME: 'GitHub Actions 12',
      RUNNER_ENVIRONMENT: 'github-hosted',
    }
    const shard = { shard: '3/8', checkout: 'a'.repeat(40), head: 'b'.repeat(40), base: undefined }
    assert.deepEqual(provenanceFromRunner(env, shard), {
      ...provenance,
      attempt: '2',
      base: null,
    })
    assert.equal(provenanceFromRunner(env, { ...shard, head: '' })?.head, 'a'.repeat(40))
    assert.equal(provenanceFromRunner({ ...env, GITHUB_RUN_ID: undefined }, shard), null)
    assert.equal(provenanceFromRunner({ ...env, RUNNER_NAME: '' }, shard), null)
    assert.equal(provenanceFromRunner(env, { ...shard, checkout: 'main' }), null)
  })
})

function emptyInputs(): Record<(typeof INPUT_CLASSES)[number], string[]> {
  return { spec: [], fixtures: [], renderer: [], assets: [], dependencies: [], capture: [] }
}
