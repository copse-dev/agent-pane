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
if (operation === 'put-object') {
  if (args[args.indexOf('--if-none-match') + 1] !== '*') process.exit(2);
  if (fs.existsSync('object.png')) { console.error('PreconditionFailed'); process.exit(1); }
  fs.copyFileSync(args[args.indexOf('--body') + 1], 'object.png');
} else if (operation === 'get-object') fs.copyFileSync('object.png', args.at(-1));
else process.exit(2);
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
      writeFileSync('object.png', 'corrupt remote object')
      await assert.rejects(screenshotStorage('upload'), /integrity/)
      assert.equal(readFileSync('object.png', 'utf8'), 'corrupt remote object')
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
