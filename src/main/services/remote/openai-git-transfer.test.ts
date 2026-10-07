import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareGitTransfer, importGitTransfer, type GitTransfer } from './openai-git-transfer.ts'
import { runHostedGitTransfer } from './openai-git-worker.ts'
import { bundleCarryOut } from '../container-runtime/guest-carry-out.ts'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
interface Fixture {
  directory: string
  host: string
  guest: string
  files: string
  transfer: GitTransfer
  exportChanges: () => void
}
async function fixture(dirty = false): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'openai-git-'))
  const host = join(directory, 'host'),
    guest = join(directory, 'guest'),
    files = join(directory, 'files')
  for (const root of [host, guest]) {
    mkdirSync(root)
    git(root, ['init', '-b', 'feature'])
    git(root, ['config', 'user.name', 'Test'])
    git(root, ['config', 'user.email', 'test@example.com'])
  }
  writeFileSync(join(host, 'code.txt'), 'original\n')
  writeFileSync(join(host, '.gitignore'), 'secret\n')
  git(host, ['add', '.'])
  git(host, ['commit', '-m', 'initial'])
  const head = git(host, ['rev-parse', 'HEAD'])
  if (dirty) writeFileSync(join(host, 'code.txt'), 'local edits\n')
  writeFileSync(join(host, 'secret'), 'never upload')
  const transfer = await prepareGitTransfer(host, files)
  assert.equal(git(host, ['rev-parse', 'HEAD']), head)
  git(guest, ['fetch', join(files, 'source.bundle'), transfer.ref])
  git(guest, ['checkout', '-B', 'work', 'FETCH_HEAD'])
  assert.equal(git(guest, ['rev-list', '--count', 'HEAD']), '1')
  assert.ok(!git(guest, ['ls-files']).includes('secret'))
  const exportChanges = (): void => {
    const commits = bundleCarryOut(git, guest, transfer.base, join(files, 'copse.bundle'))
    writeFileSync(
      join(files, 'copse-result.json'),
      JSON.stringify({
        base: transfer.base,
        head: git(guest, ['rev-parse', 'HEAD']),
        changed: commits.length > 0,
      }),
    )
  }
  return { directory, host, guest, files, transfer, exportChanges }
}

it('round trips new binary files, deletions and commits; adoption retry is idempotent', async () => {
  const f = await fixture()
  try {
    rmSync(join(f.guest, 'code.txt'))
    writeFileSync(join(f.guest, 'new.bin'), Buffer.from([0, 1, 255]))
    f.exportChanges()
    await importGitTransfer(f.transfer, f.host, f.files)
    assert.deepEqual(readFileSync(join(f.host, 'new.bin')), Buffer.from([0, 1, 255]))
    assert.equal(git(f.host, ['status', '--porcelain']), '')
    const head = git(f.host, ['rev-parse', 'HEAD'])
    f.transfer.imported = false
    await importGitTransfer(f.transfer, f.host, f.files)
    assert.equal(git(f.host, ['rev-parse', 'HEAD']), head)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
  }
})

it('retains dirty input and imports after the user commits that exact input', async () => {
  const f = await fixture(true)
  try {
    assert.equal(readFileSync(join(f.guest, 'code.txt'), 'utf8'), 'local edits\n')
    writeFileSync(join(f.guest, 'code.txt'), 'hosted edits\n')
    f.exportChanges()
    await assert.rejects(importGitTransfer(f.transfer, f.host, f.files), /Local files changed/)
    assert.equal(readFileSync(join(f.host, 'code.txt'), 'utf8'), 'local edits\n')
    git(f.host, ['add', '.'])
    git(f.host, ['commit', '-m', 'save original input'])
    await importGitTransfer(f.transfer, f.host, f.files)
    assert.equal(readFileSync(join(f.host, 'code.txt'), 'utf8'), 'hosted edits\n')
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
  }
})

it('rejects a wrong base and unrelated exported history without changing HEAD', async () => {
  const f = await fixture()
  try {
    const before = git(f.host, ['rev-parse', 'HEAD'])
    writeFileSync(
      join(f.files, 'copse-result.json'),
      JSON.stringify({ base: '0'.repeat(40), head: f.transfer.base, changed: false }),
    )
    await assert.rejects(importGitTransfer(f.transfer, f.host, f.files), /wrong snapshot/)
    git(f.guest, ['checkout', '--orphan', 'unrelated'])
    git(f.guest, ['add', '.'])
    git(f.guest, ['commit', '-m', 'unrelated'])
    git(f.guest, ['update-ref', 'refs/heads/work', 'HEAD'])
    git(f.guest, ['bundle', 'create', join(f.files, 'copse.bundle'), 'refs/heads/work'])
    writeFileSync(
      join(f.files, 'copse-result.json'),
      JSON.stringify({
        base: f.transfer.base,
        head: git(f.guest, ['rev-parse', 'HEAD']),
        changed: true,
      }),
    )
    await assert.rejects(importGitTransfer(f.transfer, f.host, f.files))
    assert.equal(git(f.host, ['rev-parse', 'HEAD']), before)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
  }
})

it('runs the shipped deterministic setup and exporter, including a no-change result', async () => {
  const f = await fixture()
  try {
    const workspace = join(f.directory, 'hosted')
    mkdirSync(join(workspace, 'inputs'), { recursive: true })
    copyFileSync(join(f.files, 'source.bundle'), join(workspace, 'inputs/source.bundle'))
    assert.throws(() => {
      runHostedGitTransfer(workspace, 'setup', '0'.repeat(40), f.transfer.ref)
    }, /Snapshot mismatch/)
    rmSync(join(workspace, 'repo'), { recursive: true })
    runHostedGitTransfer(workspace, 'setup', f.transfer.base, f.transfer.ref)
    const hostedRepo = join(workspace, 'repo')
    assert.equal(git(hostedRepo, ['remote']), '')
    runHostedGitTransfer(workspace, 'export', f.transfer.base)
    assert.match(
      readFileSync(join(workspace, 'outputs/copse-result.json'), 'utf8'),
      /"changed":false/,
    )
    writeFileSync(join(hostedRepo, 'code.txt'), 'from shipped exporter\n')
    runHostedGitTransfer(workspace, 'export', f.transfer.base)
    await importGitTransfer(f.transfer, f.host, join(workspace, 'outputs'))
    assert.equal(readFileSync(join(f.host, 'code.txt'), 'utf8'), 'from shipped exporter\n')
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
  }
})
