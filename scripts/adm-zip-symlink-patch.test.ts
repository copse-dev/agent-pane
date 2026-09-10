import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

interface AdmZipArchive {
  addFile(name: string, content: Buffer): void
  extractAllTo(target: string, overwrite: boolean): void
  extractAllToAsync(
    target: string,
    overwrite: boolean,
    keepOriginalPermission: boolean,
    callback: (error?: Error) => void,
  ): void
  extractEntryTo(
    entry: AdmZipEntry,
    target: string,
    maintainPath: boolean,
    overwrite: boolean,
  ): void
  getEntry(name: string): AdmZipEntry | null
  toBuffer(): Buffer
}

type AdmZipEntry = object

type AdmZipConstructor = new (input?: Buffer) => AdmZipArchive

function isAdmZipConstructor(value: unknown): value is AdmZipConstructor {
  return typeof value === 'function'
}

function admZipConstructor(): AdmZipConstructor {
  const manifests = globSync(
    'node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/package.json',
  )
  assert.equal(manifests.length, 1, 'expected one installed onnxruntime-node package')
  const requireFromConsumer = createRequire(resolve(manifests[0] ?? ''))
  const loaded: unknown = requireFromConsumer('adm-zip')
  assert.ok(isAdmZipConstructor(loaded), 'adm-zip should expose its CommonJS constructor')
  return loaded
}

function maliciousArchive(AdmZip: AdmZipConstructor): AdmZipArchive {
  const archive = new AdmZip()
  archive.addFile('link/payload.txt', Buffer.from('attacker content'))
  return new AdmZip(archive.toBuffer())
}

async function fixture(): Promise<{
  root: string
  destination: string
  outsideFile: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'copse-adm-zip-symlink-'))
  const destination = join(root, 'destination')
  const outside = join(root, 'outside')
  const outsideFile = join(outside, 'payload.txt')
  await mkdir(destination)
  await mkdir(outside)
  await writeFile(outsideFile, 'original')
  await symlink(outside, join(destination, 'link'), 'dir')
  return { root, destination, outsideFile }
}

describe('adm-zip destination-symlink patch (GHSA-vwc7-r8mq-g2x9)', () => {
  it(
    'blocks every extraction API from writing through a destination symlink',
    { skip: process.platform === 'win32' },
    async () => {
      const AdmZip = admZipConstructor()
      const { root, destination, outsideFile } = await fixture()
      try {
        assert.throws(() => {
          maliciousArchive(AdmZip).extractAllTo(destination, true)
        })
        assert.equal(await readFile(outsideFile, 'utf8'), 'original')

        const entryArchive = maliciousArchive(AdmZip)
        const entry = entryArchive.getEntry('link/payload.txt')
        assert.ok(entry)
        assert.throws(() => {
          entryArchive.extractEntryTo(entry, destination, true, true)
        })
        assert.equal(await readFile(outsideFile, 'utf8'), 'original')

        const asyncError = await new Promise<Error | undefined>((resolveError) => {
          maliciousArchive(AdmZip).extractAllToAsync(destination, true, false, resolveError)
        })
        assert.ok(asyncError, 'async extraction should report the refused symlink')
        assert.equal(await readFile(outsideFile, 'utf8'), 'original')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
