import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildScreenshotManifest,
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  serializeScreenshotManifest,
  screenshotObjectKey,
  verifyScreenshot,
} from './lib/screenshot-manifest.mts'
import { screenshotStorage } from './screenshot-storage.mts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=',
  'base64',
)

describe('screenshot manifest', () => {
  it('hashes and deduplicates named PNGs with deterministic serialization', () => {
    const directory = mkdtempSync(join(tmpdir(), 'screenshot-manifest-'))
    try {
      writeFileSync(join(directory, 'b.png'), png)
      writeFileSync(join(directory, 'a.png'), png)
      const manifest = buildScreenshotManifest(directory)
      const a = manifest.screenshots['a.png']
      const b = manifest.screenshots['b.png']
      assert.ok(a && b)
      assert.equal(screenshotObjectKey(a), screenshotObjectKey(b))
      assert.equal(a.bytes, png.length)
      verifyScreenshot(png, a)
      assert.throws(() => {
        verifyScreenshot(Buffer.concat([png, png]), a)
      }, /integrity/)
      assert.throws(() => {
        verifyScreenshot(Buffer.alloc(png.length), a)
      }, /integrity/)
      assert.deepEqual(parseScreenshotManifest(serializeScreenshotManifest(manifest)), manifest)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects traversal, invalid hashes, unexpected fields, and unsupported versions', () => {
    for (const value of [
      'invalid JSON',
      JSON.stringify({ version: 2, screenshots: {} }),
      JSON.stringify({
        version: 1,
        screenshots: { '../escape.png': { sha256: 'a'.repeat(64), bytes: 1 } },
      }),
      JSON.stringify({ version: 1, screenshots: { 'a.png': { sha256: 'bad', bytes: 1 } } }),
      JSON.stringify({ version: 1, screenshots: {}, bucket: 'untrusted' }),
    ])
      assert.throws(() => parseScreenshotManifest(value), /Invalid screenshot manifest/)
  })

  it('rejects empty input, disguised images, and symlinks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'screenshot-manifest-'))
    try {
      assert.throws(() => buildScreenshotManifest(directory), /empty manifest/)
      writeFileSync(join(directory, 'bad.png'), 'text')
      assert.throws(() => buildScreenshotManifest(directory), /PNG signature/)
      rmSync(join(directory, 'bad.png'))
      writeFileSync(join(directory, 'original'), png)
      symlinkSync(join(directory, 'original'), join(directory, 'alias.png'))
      assert.throws(() => buildScreenshotManifest(directory), /regular screenshot/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('screenshot storage commands', () => {
  it('uploads once per hash, verifies existing objects, and rejects corrupt remote bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'screenshot-r2-'))
    const previous = process.cwd()
    const variables = [
      'PATH',
      'SCREENSHOT_R2_ACCOUNT_ID',
      'SCREENSHOT_R2_BUCKET',
      'SCREENSHOT_R2_ACCESS_KEY_ID',
      'SCREENSHOT_R2_SECRET_ACCESS_KEY',
      'SCREENSHOT_R2_PUBLIC_URL',
    ]
    const environment = new Map(variables.map((name) => [name, process.env[name]]))
    try {
      process.chdir(directory)
      mkdirSync(SCREENSHOT_DIRECTORY, { recursive: true })
      writeFileSync(join(SCREENSHOT_DIRECTORY, 'a.png'), png)
      writeFileSync(join(SCREENSHOT_DIRECTORY, 'b.png'), png)
      const manifest = buildScreenshotManifest(SCREENSHOT_DIRECTORY)
      writeFileSync(SCREENSHOT_MANIFEST, serializeScreenshotManifest(manifest))
      // A fake AWS executable exercises the real command boundary without credentials or a network.
      writeFileSync(
        join(directory, 'aws'),
        `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (!args.includes('https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com')) process.exit(2);
const operation = args[args.indexOf('s3api') + 1];
const object = 'objects/' + args[args.indexOf('--key') + 1].split('/').at(-1);
fs.mkdirSync('objects', { recursive: true });
fs.appendFileSync('events.log', 'start\\n');
setTimeout(() => {
try {
if (operation === 'put-object') {
  if (args[args.indexOf('--if-none-match') + 1] !== '*') process.exit(2);
  if (fs.existsSync(object)) { console.error('PreconditionFailed'); process.exitCode = 1; return; }
  fs.copyFileSync(args[args.indexOf('--body') + 1], object);
} else if (operation === 'get-object') fs.copyFileSync(object, args.at(-1));
else process.exit(2);
} finally { fs.appendFileSync('events.log', 'end\\n'); }
}, 100);
`,
        { mode: 0o755 },
      )
      process.env['PATH'] = `${directory}:${process.env['PATH'] ?? ''}`
      process.env['SCREENSHOT_R2_ACCOUNT_ID'] = 'a'.repeat(32)
      process.env['SCREENSHOT_R2_BUCKET'] = 'test-bucket'
      process.env['SCREENSHOT_R2_ACCESS_KEY_ID'] = 'test-key'
      process.env['SCREENSHOT_R2_SECRET_ACCESS_KEY'] = 'test-secret'
      delete process.env['SCREENSHOT_R2_PUBLIC_URL']
      await screenshotStorage('upload')
      assert.equal(readFileSync('calls.jsonl', 'utf8').trim().split('\n').length, 2)
      await screenshotStorage('upload')
      assert.equal(readFileSync('calls.jsonl', 'utf8').trim().split('\n').length, 4)
      await screenshotStorage('verify')
      for (let i = 0; i < 9; i++) {
        writeFileSync(
          join(SCREENSHOT_DIRECTORY, `unique-${String(i)}.png`),
          Buffer.concat([png, Buffer.from([i])]),
        )
      }
      writeFileSync(
        SCREENSHOT_MANIFEST,
        serializeScreenshotManifest(buildScreenshotManifest(SCREENSHOT_DIRECTORY)),
      )
      writeFileSync('events.log', '')
      await screenshotStorage('upload')
      let active = 0
      let peak = 0
      for (const event of readFileSync('events.log', 'utf8').trim().split('\n')) {
        active += event === 'start' ? 1 : -1
        peak = Math.max(peak, active)
        assert.ok(active >= 0 && active <= 4, `Exceeded concurrency limit: ${String(active)}`)
      }
      assert.equal(active, 0)
      assert.ok(peak > 1, 'AWS processes must overlap')
      const entry = manifest.screenshots['a.png']
      assert.ok(entry)
      const object = join('objects', `${entry.sha256}.png`)
      writeFileSync(object, 'corrupt remote object')
      writeFileSync('events.log', '')
      await assert.rejects(screenshotStorage('upload'), /integrity/)
      assert.equal(readFileSync(object, 'utf8'), 'corrupt remote object')
      const events = readFileSync('events.log', 'utf8').trim().split('\n')
      assert.equal(
        events.filter((event) => event === 'start').length,
        8,
        'A failed batch must not start subsequent objects',
      )
      assert.equal(
        events.filter((event) => event === 'start').length,
        events.filter((event) => event === 'end').length,
        'All workers must finish before an upload error returns',
      )
    } finally {
      process.chdir(previous)
      for (const [name, value] of environment) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restores missing files, verifies downloads, and preserves local candidates', async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'screenshot-storage-'))
    const previous = process.cwd()
    const previousPublicUrl = process.env['SCREENSHOT_R2_PUBLIC_URL']
    try {
      process.chdir(directory)
      mkdirSync(SCREENSHOT_DIRECTORY, { recursive: true })
      writeFileSync(join(SCREENSHOT_DIRECTORY, 'a.png'), png)
      const manifest = buildScreenshotManifest(SCREENSHOT_DIRECTORY)
      writeFileSync(SCREENSHOT_MANIFEST, serializeScreenshotManifest(manifest))
      await screenshotStorage('check')
      rmSync(join(SCREENSHOT_DIRECTORY, 'a.png'))
      process.env['SCREENSHOT_R2_PUBLIC_URL'] = 'https://screenshots.example.com'
      const fetchMock = context.mock.method(globalThis, 'fetch', async () => new Response(png))
      await screenshotStorage('download')
      assert.deepEqual(readFileSync(join(SCREENSHOT_DIRECTORY, 'a.png')), png)
      assert.equal(fetchMock.mock.callCount(), 1)
      const entry = manifest.screenshots['a.png']
      assert.ok(entry)
      const requestedUrl = fetchMock.mock.calls[0]?.arguments[0]
      assert.ok(requestedUrl instanceof URL)
      assert.equal(
        requestedUrl.href,
        `https://screenshots.example.com/${screenshotObjectKey(entry)}`,
      )
      await screenshotStorage('download')
      assert.equal(fetchMock.mock.callCount(), 1)
      writeFileSync(join(SCREENSHOT_DIRECTORY, 'a.png'), 'local candidate')
      await assert.rejects(screenshotStorage('download'), /integrity/)
      await assert.rejects(screenshotStorage('upload'), /integrity/)
      assert.equal(readFileSync(join(SCREENSHOT_DIRECTORY, 'a.png'), 'utf8'), 'local candidate')
      rmSync(join(SCREENSHOT_DIRECTORY, 'a.png'))
      fetchMock.mock.mockImplementation(async () => new Response('corrupt'))
      await assert.rejects(screenshotStorage('download'), /integrity/)
    } finally {
      process.chdir(previous)
      if (previousPublicUrl === undefined) delete process.env['SCREENSHOT_R2_PUBLIC_URL']
      else process.env['SCREENSHOT_R2_PUBLIC_URL'] = previousPublicUrl
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
