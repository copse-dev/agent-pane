import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { buildSync } from 'esbuild'

// These executable modules are also imported as libraries by the unit suite.
// A different executable with the same basename must not activate their CLI.
const EXECUTABLE_LIBRARIES = [
  'acp-v2-watch',
  'assemble-macos-release',
  'base-freshness',
  'check-macos-native-toolchain',
  'check-macos-release-size',
  'check-packaged-licenses',
  'copy-monaco-workers',
  'demo-preview-reconcile',
  'filter-screenshots',
  'prune-scaleway-ips',
  'prune-scaleway-volumes',
  'rebuild-dmg-blockmap',
  'release-bump',
  'release-notes',
  'remote-e2e',
  'run-skillsbench-fleet',
  'run-terminal-bench-fleet',
  'serve-local-classifier',
  'sync-intellect',
  'sync-model-cards',
  'sync-model-catalog',
  'sync-site-markdown',
  'test-oracle',
] as const

const BUNDLED_LIBRARIES = [
  'background-question-eval-lib',
  'doctrine-eval-lib',
  'steer-eval-lib',
  'thread-title-eval-lib',
]

for (const name of [...EXECUTABLE_LIBRARIES, ...BUNDLED_LIBRARIES]) {
  it(`importing ${name} from a same-named executable has no CLI effects`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'copse-import-'))
    try {
      const bundled = BUNDLED_LIBRARIES.includes(name)
      const importer = join(directory, `${name}.${bundled ? 'cjs' : 'mts'}`)
      writeFileSync(importer, '')
      if (bundled) mkdirSync(resolve('.tmp'), { recursive: true })
      const bundle = bundled ? mkdtempSync(resolve('.tmp/cli-import-')) : undefined
      const modulePath = bundle ? join(bundle, `${name}.cjs`) : resolve(`scripts/${name}.mts`)
      if (bundle) {
        buildSync({
          entryPoints: [resolve(`scripts/${name}.mts`)],
          outfile: modulePath,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          alias: { '@shared': resolve('src/shared') },
          packages: 'external',
          logLevel: 'silent',
        })
      }
      const url = pathToFileURL(modulePath).href
      const probe = `
        import fs from 'node:fs';
        import fsp from 'node:fs/promises';
        import childProcess from 'node:child_process';
        import { Server } from 'node:net';
        import { syncBuiltinESMExports } from 'node:module';
        const effects = [];
        const forbid = (name) => (...args) => {
          effects.push(name);
          throw new Error('Import activated CLI effect: ' + name);
        };
        for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile', 'cp', 'mkdtemp', 'symlink', 'link', 'chmod', 'chown', 'truncate', 'utimes', 'rmdir', 'createWriteStream']) {
          if (typeof fs[name] === 'function') fs[name] = forbid(name);
          if (typeof fs[name + 'Sync'] === 'function') fs[name + 'Sync'] = forbid(name + 'Sync');
          if (typeof fsp[name] === 'function') fsp[name] = forbid(name);
        }
        for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = forbid(name);
        Server.prototype.listen = forbid('listen');
        globalThis.fetch = forbid('fetch');
        process.exit = forbid('exit');
        syncBuiltinESMExports();
        process.argv[1] = ${JSON.stringify(importer)};
        process.argv[2] = 'fixture-argument';
        await import(${JSON.stringify(url)});
        await new Promise(resolve => setImmediate(resolve));
        if (effects.length) throw new Error(effects.join(', '));
      `
      try {
        assert.equal(
          execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
            cwd: resolve('.'),
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          }),
          '',
          'imports must be silent and must not perform CLI work',
        )
        if (name === 'background-question-eval-lib') {
          // The real eval runner emits this CJS filename. Invalid arguments
          // must reach its parser and fail before any fixture/provider work.
          const direct = spawnSync(process.execPath, [modulePath, '--invalid-entrypoint-fixture'], {
            cwd: resolve('.'),
            encoding: 'utf8',
            timeout: 30_000,
          })
          assert.equal(direct.error, undefined)
          assert.equal(direct.status, 1)
          assert.match(
            direct.stderr,
            /Unknown or incomplete argument '--invalid-entrypoint-fixture'/,
          )
        }
      } finally {
        if (bundle) rmSync(bundle, { recursive: true, force: true })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

it('keeps the explicit Monaco generator available through normal and symlinked CLI paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copse-generator-'))
  try {
    for (const path of [
      'node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js',
      'node_modules/monaco-editor/esm/vs/language/json/json.worker.js',
      'node_modules/monaco-editor/esm/vs/language/css/css.worker.js',
      'node_modules/monaco-editor/esm/vs/language/html/html.worker.js',
      'node_modules/monaco-editor/esm/external/fixture.js',
      'src/renderer/monaco/esm-worker-host.js',
    ]) {
      const target = join(directory, path)
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, 'fixture worker')
    }
    const command = resolve('scripts/copy-monaco-workers.mts')
    const alias = join(directory, 'generator-alias.mts')
    symlinkSync(command, alias)
    for (const [index, entrypoint] of [command, alias].entries()) {
      const output = join(directory, `output-${String(index)}`)
      const stdout = execFileSync(process.execPath, [entrypoint, output], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 30_000,
      })
      assert.match(stdout, /\[monaco\] populated/)
      assert.equal(
        readFileSync(join(output, 'vs/language/json/jsonWorker.js'), 'utf8'),
        'fixture worker',
      )
      assert.equal(readFileSync(join(output, 'esm-worker-host.js'), 'utf8'), 'fixture worker')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('loads the native classifier CLI and reports usage before any installation or inference', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/serve-local-classifier.mts')], {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^Usage: pnpm run classifier:serve -- <kev\|winnow>/)
})
