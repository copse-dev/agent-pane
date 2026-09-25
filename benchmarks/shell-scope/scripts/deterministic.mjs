import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, prior, corpus, repository, z, sha, safeJsonParse, decodeWithSchema } from './run.mjs'
const sourceRoot = resolve(repository, 'packages/shell-guard/src')
const appSecurity = resolve(repository, 'src/main/services/security')
const esbuild = createRequire(resolve(prior, 'package.json'))('esbuild')
const output = resolve(root, 'deterministic-v1')
await mkdir(root, { recursive: true })
await mkdir(output, { mode: 0o700 })
const bundle = resolve(output, 'guard.bundle.mjs')
const built = await esbuild.build({
  stdin: {
    contents: `export * from ${JSON.stringify(resolve(sourceRoot, 'index.ts'))};\nexport { assessAutoApproval } from ${JSON.stringify(resolve(appSecurity, 'auto-approval.ts'))};`,
    resolveDir: repository,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  metafile: true,
  nodePaths: [resolve(prior, 'node_modules')],
  alias: { '@shared': resolve(repository, 'src/shared'), '@copse/shell-guard': sourceRoot },
  plugins: [
    {
      name: 'pure-guard-fixture-context',
      setup(build) {
        build.onResolve(
          { filter: /^\.\/(shell-scope|shell-argv|command-routing|shell-harm)\.ts$/ },
          (args) => {
            if (dirname(args.importer) !== appSecurity) return null
            return { path: resolve(sourceRoot, args.path) }
          },
        )
      },
    },
  ],
})
// Do not import host settings/environment binders into this prospective fixture.
assert.ok(
  Object.keys(built.metafile.inputs).every(
    (name) => !/shell-guard-environment|settings-store|config-store/.test(name),
  ),
)
const sourceHashes = {}
for (const name of Object.keys(built.metafile.inputs)) {
  if (name === '<stdin>') continue
  const path = resolve(repository, name)
  sourceHashes[relative(repository, path)] = sha(await readFile(path))
}
const guard = await import(pathToFileURL(bundle).href)
guard.configureShellScopeEnvironment()
assert.equal(
  guard.analyzeShellCommand('cat docs/guide.txt', '/workspace/project').verdict,
  'sandbox',
)
assert.equal(
  guard.analyzeShellCommand('cat /outside/guide.txt', '/workspace/project').verdict,
  'external',
)
assert.equal(
  guard.assessAutoApproval('unrecognized-fixture-program', {
    workspaceRoot: '/workspace/project',
    level: 'read',
    configuredRemotes: new Set(),
  }).action,
  'prompt',
)
const text = await readFile(resolve(corpus, 'corpus.jsonl'), 'utf8')
assert.equal(sha(text), '817c95cfcdb30a27002cbb73d7cde0cef288a6e026b8e331b8597c2b5ac72ccd')
const dataset = safeJsonParse(
  text,
  decodeWithSchema(
    z.looseObject({
      cases: z.array(
        z.looseObject({
          id: z.string(),
          command: z.string(),
          split: z.string(),
          source: z.string(),
          label: z.enum(['sandbox', 'external']),
        }),
      ),
    }),
  ),
)
const rows = dataset.cases.map((example) => {
  const start = performance.now()
  const scope = guard.analyzeShellCommand(example.command, '/workspace/project')
  const harm = guard.assessShellHarm(example.command, {
    workspaceRoot: '/workspace/project',
    homeDir: '/home/user',
    readScript: () => null,
    canonicalizePath: (path) => path,
  })
  const shapeHandling = guard.assessAutoApproval(example.command, {
    workspaceRoot: '/workspace/project',
    level: 'read',
    configuredRemotes: new Set(),
    canonicalizePath: (path) => path,
  })
  const structuralReadOnly = guard.isStructurallyReadOnlyShellCommand(example.command)
  return {
    ...example,
    scope,
    harm,
    shapeHandling,
    structuralReadOnly,
    elapsedMs: performance.now() - start,
  }
})
const summaries = []
for (const split of ['dev', 'holdout']) {
  for (const source of ['all', 'thread-adapted', 'controlled']) {
    const selected = rows.filter(
      (row) => row.split === split && (source === 'all' || row.source === source),
    )
    summaries.push({
      split,
      source,
      planned: selected.length,
      exactBinaryAgreement: selected.filter((row) => row.scope.verdict === row.label).length,
      ambiguous: selected.filter((row) => row.scope.verdict === 'ambiguous').length,
      conservativeBinaryAgreement: selected.filter(
        (row) => (row.scope.verdict === 'sandbox' ? 'sandbox' : 'external') === row.label,
      ).length,
      wrongSandbox: selected.filter(
        (row) => row.label === 'external' && row.scope.verdict === 'sandbox',
      ).length,
      wrongExternal: selected.filter(
        (row) => row.label === 'sandbox' && row.scope.verdict === 'external',
      ).length,
      ambiguousSandboxLabel: selected.filter(
        (row) => row.label === 'sandbox' && row.scope.verdict === 'ambiguous',
      ).length,
      harm: Object.fromEntries(
        ['allow', 'prompt', 'deny'].map((action) => [
          action,
          selected.filter((row) => row.harm.action === action).length,
        ]),
      ),
      shapeHandling: Object.fromEntries(
        ['auto-approve', 'prompt'].map((action) => [
          action,
          selected.filter((row) => row.shapeHandling.action === action).length,
        ]),
      ),
    })
  }
}
const metadata = {
  createdAt: new Date().toISOString(),
  repositoryBase: 'current checkout; identify by sourceHashes, not the historical baseline',
  datasetHash: sha(text),
  sourceHashes,
  bundleHash: sha(await readFile(bundle)),
  fixtureContext: {
    workspaceRoot: '/workspace/project',
    homeDir: '/home/user',
    sanctionedRoots: [],
    scriptContents: 'unknown',
    symlinks: 'none',
    shapePolicy: 'read only; no configured remote grants',
  },
  notes: [
    'Pure source APIs only; app host environment binders intentionally replaced by their unchanged pure re-exports.',
    'Scope preserves ambiguous; conservative binary mapping is a separately labeled hypothetical projection.',
    'Harm and shape handling are separate outputs without independent gold labels; no accuracy claim for these channels.',
    'A shape prompt can mean unrecognized, unsupported or disallowed effects. It is not an unknown-command label and not the final permission gate.',
    'Scope API does not accept arbitrary environment values or all semantic assumptions supplied to models; raw command text is not pre-expanded.',
    'All fixture commands remain data. No execution or authorization effects.',
  ],
  publishEligible: false,
}
await writeFile(
  resolve(output, 'analysis.json'),
  JSON.stringify({ metadata, summaries, rows }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 },
)
const lines = [
  '# Deterministic components',
  '',
  '| Split | Source | Exact agreement | Ambiguous | Conservative binary agreement | Wrong sandbox | Wrong external | Harm allow/prompt/deny | Shape eligible/prompt |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...summaries.map(
    (row) =>
      `| ${row.split} | ${row.source} | ${row.exactBinaryAgreement}/${row.planned} | ${row.ambiguous} | ${row.conservativeBinaryAgreement}/${row.planned} | ${row.wrongSandbox} | ${row.wrongExternal} | ${row.harm.allow}/${row.harm.prompt}/${row.harm.deny} | ${row.shapeHandling['auto-approve']}/${row.shapeHandling.prompt} |`,
  ),
  '',
  ...metadata.notes.map((note) => `- ${note}`),
  '',
]
await writeFile(resolve(output, 'report.md'), lines.join('\n'), { flag: 'wx', mode: 0o600 })
console.log(lines.join('\n'))
