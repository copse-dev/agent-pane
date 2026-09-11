import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

function fixture(): {
  root: string
  manifest: string
  row: string
  target: string
  run: () => SpawnSyncReturns<string>
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copse library with spaces ')))
  const manifest = join(root, 'collection.tsv')
  const target = join(root, 'models/publisher/model/weights.gguf')
  const checksum = createHash('sha256').update('model bytes').digest('hex')
  const row = ['publisher/model', 'a'.repeat(40), 'weights.gguf', checksum, '11'].join('\t')
  writeFileSync(manifest, row + '\n')
  const run = (): SpawnSyncReturns<string> =>
    spawnSync('/bin/bash', [resolve('scripts/portable/model-library.sh'), root, manifest], {
      encoding: 'utf8',
      env: { ...process.env, COPSE_PORTABLE_OFFLINE: '1' },
      timeout: 10000,
    })
  return { root, manifest, row, target, run }
}

test('offline library verification reuses matching files and rejects absent or corrupt bytes', () => {
  const f = fixture()
  try {
    assert.match(f.run().stderr, /Offline setup needs a valid cached download/)
    mkdirSync(join(f.root, 'models/publisher/model'), { recursive: true })
    writeFileSync(f.target, 'model bytes')
    const valid = f.run()
    assert.equal(valid.status, 0, valid.stderr)
    writeFileSync(f.target, 'corrupt')
    assert.equal(f.run().status, 1)
    assert.equal(readFileSync(f.target, 'utf8'), 'corrupt')
    // A valid last row without a newline must not be silently skipped.
    writeFileSync(f.manifest, f.row)
    assert.equal(f.run().status, 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('model manifests reject traversal, duplicate destinations and incomplete pins', () => {
  const f = fixture()
  try {
    for (const row of [
      f.row.replace('weights.gguf', '../../outside'),
      f.row.replace('publisher/model', '../model'),
      f.row.replace('a'.repeat(40), 'main'),
      f.row + '\n' + f.row,
      'incomplete',
    ]) {
      writeFileSync(f.manifest, row + '\n')
      const result = f.run()
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Invalid/)
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('model installation refuses destination symlinks without changing their target', () => {
  const f = fixture()
  try {
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'preserve'), 'unchanged')
    symlinkSync(outside, join(f.root, 'models'))
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /destination is a symlink/)
    assert.equal(readFileSync(join(outside, 'preserve'), 'utf8'), 'unchanged')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('identical files in different model folders can be reconstructed offline from one verified copy', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'models/publisher/model'), { recursive: true })
    writeFileSync(f.target, 'model bytes')
    writeFileSync(
      f.manifest,
      f.row + '\n' + f.row.replace('publisher/model', 'publisher/another-model') + '\n',
    )
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      readFileSync(join(f.root, 'models/publisher/another-model/weights.gguf'), 'utf8'),
      'model bytes',
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('download authentication is sent through stdin only for Hugging Face', () => {
  const f = fixture()
  try {
    const script = `
set -euo pipefail
source "$1"
/usr/bin/curl() {
  header=no
  output=''
  while [ "$#" -gt 0 ]; do
    case "$1" in --header) header=yes; shift ;; -o) output="$2"; shift ;; esac
    shift
  done
  if [ "$header" = yes ]; then cat > "$capture"; fi
  printf 'model bytes' > "$output"
}
`
    // Substitute the process boundary without exposing a test-only product option.
    const mock = script + '\ncapture="$3"\ndownload "$4" "$2" "$5"\n'
    const run = (url: string, target: string, capture: string): SpawnSyncReturns<string> =>
      spawnSync(
        '/bin/bash',
        [
          '-c',
          mock,
          'bash',
          resolve('scripts/portable/download.sh'),
          target,
          capture,
          url,
          createHash('sha256').update('model bytes').digest('hex'),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, HF_TOKEN: 'test-token', COPSE_PORTABLE_OFFLINE: '0' },
        },
      )
    const capture = join(f.root, 'header')
    const hf = run(
      'https://huggingface.co/publisher/model/resolve/revision/file',
      join(f.root, 'hf'),
      capture,
    )
    assert.equal(hf.status, 0, hf.stderr)
    assert.equal(readFileSync(capture, 'utf8'), 'Authorization: Bearer test-token\n')
    rmSync(capture)
    const unrelated = run(
      'https://runtime-extensions.lmstudio.ai/download/example',
      join(f.root, 'runtime'),
      capture,
    )
    assert.equal(unrelated.status, 0, unrelated.stderr)
    assert.equal(readFileSync(join(f.root, 'runtime'), 'utf8'), 'model bytes')
    assert.throws(() => readFileSync(capture))
    assert.doesNotMatch(hf.stdout + hf.stderr + unrelated.stdout + unrelated.stderr, /test-token/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
