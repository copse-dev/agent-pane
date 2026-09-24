// This program is passed to node inside the existing execution cell, never
// imported or evaluated on the model host. It uses each checkout's esbuild and
// dependencies, so old base revisions do not need a newly added test script.
const REPRODUCER_RUNNER_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const test = process.argv[1];
let output;
try {
  const require = createRequire(join(root, 'package.json'));
  const esbuild = require('esbuild');
  output = mkdtempSync(join(root, '.copse-review/compiled-'));
  const entry = join(output, 'test.mjs');
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [resolve(root, test)],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: 'inline',
    banner: { js: "import { createRequire as __copseRequire } from 'node:module'; const require = __copseRequire(" + JSON.stringify(join(root, 'package.json')) + ");" },
    logLevel: 'silent',
  });
  const result = spawnSync(process.execPath, ['--test', entry], { cwd: root, stdio: 'inherit' });
  if (result.error || result.signal || result.status === null) {
    throw result.error ?? new Error('test process did not exit normally');
  }
  process.exitCode = result.status;
} catch (error) {
  console.error('[copse-test] Test setup failed; this is not evidence of the reported bug.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
} finally {
  if (output) rmSync(output, { recursive: true, force: true });
}
`

/** argv stays literal: no shell, host execution, installs or network fallback. */
export function reproducerTestArgv(path: string): readonly [string, ...string[]] {
  return ['node', '--input-type=module', '--eval', REPRODUCER_RUNNER_SOURCE, path]
}
