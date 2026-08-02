import { describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeToolExecuteResult, type ToolExecuteResult } from '@shared/types'
import { createZipArchive } from '../services/storage/zip-archive.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import {
  ownedIt as it,
  TEST_THREAD_OWNER,
} from '../services/thread-execution-context.test-support.ts'
import { readArchiveTool } from './read-archive-tool.ts'

const MODIFIED = new Date(2026, 2, 4, 5, 6, 8)
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

const signal = new AbortController().signal

function run(args: Record<string, unknown>): Promise<ToolExecuteResult> {
  return Promise.resolve(readArchiveTool.execute(readArchiveTool.parameters.parse(args), signal))
}

function zip(files: Record<string, string>): Promise<Uint8Array> {
  return createZipArchive(
    Object.entries(files).map(([path, body]) => ({
      path,
      data: utf8(body),
      modifiedAt: MODIFIED,
    })),
  )
}

/** The extraction root the tool reports, pulled back out of its result header. */
function extractionRoot(result: string): string {
  const match = /extracted to (\S+)/.exec(result) ?? /already extracted to (\S+)/.exec(result)
  assert.ok(match?.[1], `expected an extraction root in:\n${result}`)
  return match[1]
}

describe('read_archive tool', () => {
  let tempRoot = ''
  let storeRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let previousStore: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-read-archive-'))
    storeRoot = await mkdtemp(join(tmpdir(), 'copse-read-archive-store-'))
    previousStore = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = storeRoot
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = undefined
    if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    await rm(tempRoot, { recursive: true, force: true })
    await rm(storeRoot, { recursive: true, force: true })
  })

  it('extracts a workspace archive and lists what it contained', async () => {
    await writeFile(
      join(tempRoot, 'bundle.zip'),
      await zip({ 'README.md': '# hi', 'src/app.ts': 'export const a = 1\n' }),
    )

    const result = normalizeToolExecuteResult(await run({ path: 'bundle.zip' }))

    assert.match(result.result, /bundle\.zip — 2 files extracted to /)
    assert.match(result.result, /README\.md {2}\(4 B\)/)
    assert.match(result.result, /src\/app\.ts/)
    // The listing is useless unless the model knows what to do next.
    assert.match(result.result, /ordinary files on disk/)
    assert.match(result.result, /Do not call read_archive again for individual entries/)

    // The extracted files really are where the tool says, and readable.
    const root = extractionRoot(result.result)
    assert.ok(root.includes(TEST_THREAD_OWNER.threadId), root)
    assert.equal(await readFile(join(root, 'src', 'app.ts'), 'utf8'), 'export const a = 1\n')
  })

  it('reuses a previous extraction instead of unpacking twice', async () => {
    await writeFile(join(tempRoot, 'bundle.zip'), await zip({ 'a.txt': 'a' }))

    const first = normalizeToolExecuteResult(await run({ path: 'bundle.zip' }))
    const second = normalizeToolExecuteResult(await run({ path: 'bundle.zip' }))

    assert.match(second.result, /already extracted to /)
    assert.equal(extractionRoot(second.result), extractionRoot(first.result))
  })

  it('reports entries it refused rather than dropping them silently', async () => {
    await writeFile(
      join(tempRoot, 'hostile.zip'),
      await createZipArchive([
        { path: '../escape.txt', data: utf8('pwned'), modifiedAt: MODIFIED },
        { path: 'safe.txt', data: utf8('ok'), modifiedAt: MODIFIED },
      ]),
    )

    const result = normalizeToolExecuteResult(await run({ path: 'hostile.zip' }))

    assert.match(result.result, /1 file extracted/)
    assert.match(
      result.result,
      /Skipped 1 entry: \.\.\/escape\.txt \(path escapes the archive root\)/,
    )
    assert.doesNotMatch(result.result, /^ {2}\.\.\/escape\.txt/m)
  })

  it('refuses a path that is not an archive before touching the disk', async () => {
    const result = normalizeToolExecuteResult(await run({ path: 'notes.md' }))
    assert.match(result.result, /not a supported archive/)
  })

  it('explains a file that is not really a zip', async () => {
    await writeFile(join(tempRoot, 'fake.zip'), 'this is just text pretending to be an archive')
    const result = normalizeToolExecuteResult(await run({ path: 'fake.zip' }))
    assert.match(result.result, /Could not extract fake\.zip: .*Not a zip file/)
  })

  it('refuses a path outside the workspace and the chat store', async () => {
    const result = normalizeToolExecuteResult(await run({ path: '/etc/secrets.zip' }))
    assert.match(result.result, /outside workspace or chat store/)
  })
})
