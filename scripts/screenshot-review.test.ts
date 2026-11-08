import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { PNG } from 'pngjs'
import {
  collectReview,
  discoverReview,
  loadReviewLedger,
  screenshotReview,
} from './screenshot-review.mts'
import {
  makeReviewPacket,
  parseReviewLedger,
  parseReviewPacket,
  recordReview,
  reviewProgress,
  type ReviewEvidence,
} from './lib/screenshot-review-records.mts'
import {
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  screenshotHash,
} from './lib/screenshot-manifest.mts'

function png(red: number): Buffer {
  const image = new PNG({ width: 2, height: 3 })
  image.data.fill(red)
  return PNG.sync.write(image)
}

function fixture(): {
  cwd: string
  git: (...args: string[]) => string
  commit: () => string
  evidence: ReviewEvidence
  directory: string
  original: Buffer
  changed: Buffer
  candidate: Buffer
  dispose: () => void
} {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'review-packet-')))
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim()
  }
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.test')
  writeFileSync(join(cwd, '.gitignore'), '.tmp/\n')
  mkdirSync(join(cwd, SCREENSHOT_DIRECTORY), { recursive: true })
  const original = png(1),
    changed = png(2),
    candidate = png(3)
  function commit(): string {
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png'), original)
  writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'removed.png'), original)
  const base = commit()
  writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png'), changed)
  rmSync(join(cwd, SCREENSHOT_DIRECTORY, 'removed.png'))
  const head = commit()
  writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'a.png'), candidate)
  writeFileSync(join(cwd, SCREENSHOT_DIRECTORY, 'new.png'), candidate)
  const compare = commit()
  const evidence: ReviewEvidence = {
    repository: 'owner/repo',
    pr: 42,
    base,
    head,
    compare,
    run: '123',
    context: 'Linux, Chromium pinned, focused fixture; provenance checked by reviewer',
    mode: 'pr',
  }
  const directory = join(cwd, '.tmp', 'screenshot-review', '42')
  return {
    cwd,
    git,
    commit,
    evidence,
    directory,
    original,
    changed,
    candidate,
    dispose: (): void => {
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

describe('screenshot review packets', () => {
  it(
    'discovers and fetches immutable refs with read-only GitHub lookup, rejecting a stale run',
    {
      skip:
        process.platform === 'win32'
          ? 'POSIX fake gh executable; Git packet tests run on every platform'
          : false,
    },
    () => {
      const f = fixture()
      const oldPath = process.env['PATH']
      try {
        const bin = join(f.cwd, '.tmp', 'bin')
        mkdirSync(bin, { recursive: true })
        const pull = {
          state: 'open',
          head: { sha: f.evidence.head, repo: { full_name: 'owner/repo' } },
          base: { sha: f.evidence.base },
        }
        const run = {
          head_sha: f.evidence.head,
          conclusion: 'success',
          path: '.github/workflows/ci.yml',
          html_url: 'https://github.com/owner/repo/actions/runs/123',
        }
        const metadata = join(bin, 'run.json')
        const jobs = join(bin, 'jobs.json')
        writeFileSync(metadata, JSON.stringify(run))
        writeFileSync(jobs, JSON.stringify({ jobs: [] }))
        writeFileSync(
          join(bin, 'gh'),
          `#!/usr/bin/env node\nconst fs = require('node:fs'); const p = process.argv.at(-1); process.stdout.write(p.includes('/pulls/') ? ${JSON.stringify(JSON.stringify(pull))} : fs.readFileSync(p.includes('/jobs?filter=latest') ? ${JSON.stringify(jobs)} : ${JSON.stringify(metadata)}, 'utf8'));\n`,
          { mode: 0o755 },
        )
        process.env['PATH'] = `${bin}:${oldPath ?? ''}`
        f.git('config', `url.${f.cwd}.insteadOf`, 'https://github.com/owner/repo.git')
        f.git(
          'branch',
          `screenshot-compare/pr-42/${f.evidence.head.slice(0, 12)}`,
          f.evidence.compare,
        )
        assert.deepEqual(discoverReview(f.cwd, 'owner/repo', 42, '123'), {
          base: f.evidence.base,
          head: f.evidence.head,
          compare: f.evidence.compare,
        })
        writeFileSync(metadata, JSON.stringify({ ...run, head_sha: f.evidence.base }))
        assert.throws(() => discoverReview(f.cwd, 'owner/repo', 42, '123'), /current-head CI/)
        writeFileSync(metadata, JSON.stringify({ ...run, path: '.github/workflows/untrusted.yml' }))
        assert.throws(() => discoverReview(f.cwd, 'owner/repo', 42, '123'), /current-head CI/)
        // A red run counts only when its candidate job rendered the screenshots.
        writeFileSync(metadata, JSON.stringify({ ...run, conclusion: 'failure' }))
        assert.throws(() => discoverReview(f.cwd, 'owner/repo', 42, '123'), /current-head CI/)
        writeFileSync(
          jobs,
          JSON.stringify({ jobs: [{ name: 'screenshot-artifacts', conclusion: 'skipped' }] }),
        )
        assert.throws(() => discoverReview(f.cwd, 'owner/repo', 42, '123'), /current-head CI/)
        writeFileSync(
          jobs,
          JSON.stringify({
            jobs: [
              { name: 'check', conclusion: 'failure' },
              { name: 'screenshot-artifacts', conclusion: 'success' },
            ],
          }),
        )
        assert.equal(discoverReview(f.cwd, 'owner/repo', 42, '123').compare, f.evidence.compare)
        writeFileSync(metadata, JSON.stringify({ ...run, conclusion: 'cancelled' }))
        assert.throws(() => discoverReview(f.cwd, 'owner/repo', 42, '123'), /current-head CI/)
      } finally {
        if (oldPath === undefined) delete process.env['PATH']
        else process.env['PATH'] = oldPath
        f.dispose()
      }
    },
  )

  it('collects complete committed/candidate evidence including deletions without changing the worktree', async () => {
    const f = fixture()
    try {
      const before = f.git('diff', 'HEAD')
      const packet = await collectReview(f.cwd, f.evidence, f.directory)
      assert.deepEqual(
        packet.items.map((item) => item.id),
        ['committed/a.png', 'committed/removed.png', 'candidate/a.png', 'candidate/new.png'],
      )
      assert.equal(packet.items[0]?.before?.width, 2)
      assert.equal(packet.items[0].after?.height, 3)
      assert.equal(packet.items[1]?.after, null)
      assert.equal(packet.items[3]?.before, null)
      assert.equal(f.git('diff', 'HEAD'), before)
      assert.match(readFileSync(join(f.directory, 'review.md'), 'utf8'), /Recorded: 0\/4/)
      assert.deepEqual(parseReviewPacket(JSON.stringify(packet)), packet)
      assert.throws(
        () => parseReviewPacket(JSON.stringify({ ...packet, fingerprint: '0'.repeat(64) })),
        /Invalid/,
      )
    } finally {
      f.dispose()
    }
  })

  it('resumes exact evidence, requires revalidation on any evidence change, and retains old notes', async () => {
    const f = fixture()
    try {
      const packet = await collectReview(f.cwd, f.evidence, f.directory)
      const ledger = recordReview(
        packet,
        { version: 1, receipts: [] },
        'candidate/a.png',
        'intentional',
        'Toolbar change inspected at full resolution',
      )
      writeFileSync(join(f.directory, 'receipts.json'), JSON.stringify(ledger))
      const again = await collectReview(f.cwd, f.evidence, f.directory)
      assert.equal(reviewProgress(again, loadReviewLedger(f.directory))[2]?.state, 'recorded')
      for (const evidence of [
        { ...f.evidence, run: '456' },
        { ...f.evidence, context: 'Different browser' },
        { ...f.evidence, head: 'a'.repeat(40) },
      ]) {
        const fresh = makeReviewPacket(evidence, packet.items)
        assert.equal(reviewProgress(fresh, ledger)[2]?.state, 'revalidate')
        const recorded = recordReview(
          fresh,
          ledger,
          'candidate/a.png',
          'breakage',
          'New intent reveals missing control',
        )
        assert.equal(recorded.receipts.length, 2)
        assert.equal(reviewProgress(fresh, recorded)[2]?.receipt?.classification, 'breakage')
      }
      const changedPair = makeReviewPacket(
        f.evidence,
        packet.items.map((item) => ({
          ...item,
          after: item.after ? { ...item.after, sha256: 'f'.repeat(64) } : null,
        })),
      )
      assert.equal(reviewProgress(changedPair, ledger)[2]?.state, 'unreviewed')
      const differentPR = makeReviewPacket({ ...f.evidence, pr: 43 }, packet.items)
      assert.equal(reviewProgress(differentPR, ledger)[2]?.state, 'unreviewed')
      assert.throws(
        () => recordReview(packet, ledger, 'candidate/missing.png', 'intentional', 'note'),
        /Unknown/,
      )
      assert.throws(() => parseReviewLedger('{broken'), /preserve/)
    } finally {
      f.dispose()
    }
  })

  it('rejects stale parent, non-image changes, and corrupt progress before replacing the current packet', async () => {
    const f = fixture()
    try {
      await assert.rejects(
        collectReview(f.cwd, { ...f.evidence, head: f.evidence.base }, f.directory),
        /one parent/,
      )
      const packet = await collectReview(f.cwd, f.evidence, f.directory)
      writeFileSync(join(f.cwd, 'product.ts'), 'not screenshot evidence')
      const bad = f.commit()
      await assert.rejects(
        collectReview(
          f.cwd,
          { ...f.evidence, head: f.evidence.compare, compare: bad },
          f.directory,
        ),
        /only add or modify/,
      )
      writeFileSync(join(f.directory, 'receipts.json'), '{}')
      await assert.rejects(collectReview(f.cwd, f.evidence, f.directory), /Invalid review ledger/)
      assert.equal(
        parseReviewPacket(readFileSync(join(f.directory, 'current.json'), 'utf8')).fingerprint,
        packet.fingerprint,
      )
    } finally {
      f.dispose()
    }
  })

  it('supports R2 manifest evidence, verifies downloaded bytes and fails on missing objects', async () => {
    const f = fixture()
    try {
      // Switch to a manifest-based head; old PNGs remain accessible in base history.
      for (const name of ['a.png', 'new.png']) rmSync(join(f.cwd, SCREENSHOT_DIRECTORY, name))
      const entry = (bytes: Buffer): { sha256: string; bytes: number } => ({
        sha256: screenshotHash(bytes),
        bytes: bytes.length,
      })
      const manifest = (bytes: Buffer): string =>
        JSON.stringify({ version: 1, screenshots: { 'a.png': entry(bytes) } })
      writeFileSync(join(f.cwd, SCREENSHOT_MANIFEST), manifest(f.changed))
      const head = f.commit()
      writeFileSync(join(f.cwd, SCREENSHOT_MANIFEST), manifest(f.candidate))
      const compare = f.commit()
      const evidence = { ...f.evidence, head, compare }
      await assert.rejects(
        collectReview(f.cwd, evidence, f.directory, async () => Buffer.from('bad')),
        /integrity mismatch/,
      )
      assert.equal(existsSync(join(f.directory, 'current.json')), false)
      await assert.rejects(
        collectReview(f.cwd, evidence, f.directory, async () => {
          throw new Error('404')
        }),
        /404/,
      )
      const packet = await collectReview(f.cwd, evidence, f.directory, async (e) =>
        e.sha256 === screenshotHash(f.changed) ? f.changed : f.candidate,
      )
      assert.equal(
        packet.items.find((item) => item.id === 'candidate/a.png')?.after?.sha256,
        screenshotHash(f.candidate),
      )
      // A manifest-only removal is not legitimate publisher evidence.
      writeFileSync(
        join(f.cwd, SCREENSHOT_MANIFEST),
        JSON.stringify({ version: 1, screenshots: {} }),
      )
      const removed = f.commit()
      await assert.rejects(
        collectReview(f.cwd, { ...evidence, head: compare, compare: removed }, f.directory),
        /cannot remove/,
      )
    } finally {
      f.dispose()
    }
  })

  it('allows only manifest-derived README image replacements in publisher evidence', async () => {
    const f = fixture()
    try {
      for (const name of ['a.png', 'new.png']) rmSync(join(f.cwd, SCREENSHOT_DIRECTORY, name))
      const manifest = (bytes: Buffer): string =>
        JSON.stringify({
          version: 1,
          screenshots: {
            'landing-cupcake-changes.png': { sha256: screenshotHash(bytes), bytes: bytes.length },
          },
        })
      const readme = (bytes: Buffer): string =>
        `# Copse\n![Preview](https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev/screenshots/sha256/${screenshotHash(bytes)}.png)\n`
      writeFileSync(join(f.cwd, SCREENSHOT_MANIFEST), manifest(f.changed))
      writeFileSync(join(f.cwd, 'README.md'), readme(f.changed))
      const head = f.commit()
      writeFileSync(join(f.cwd, SCREENSHOT_MANIFEST), manifest(f.candidate))
      writeFileSync(join(f.cwd, 'README.md'), readme(f.candidate))
      const compare = f.commit()
      const evidence = { ...f.evidence, head, compare }
      const packet = await collectReview(f.cwd, evidence, f.directory, async (entry) =>
        entry.sha256 === screenshotHash(f.changed) ? f.changed : f.candidate,
      )
      assert.equal(packet.items.filter((item) => item.id.startsWith('candidate/')).length, 1)
      for (const invalid of [readme(f.candidate) + 'unrelated prose\n', readme(f.original)]) {
        f.git('reset', '--hard', compare)
        writeFileSync(join(f.cwd, 'README.md'), invalid)
        f.git('add', 'README.md')
        f.git('commit', '--amend', '--no-edit', '-q')
        await assert.rejects(
          collectReview(f.cwd, { ...evidence, compare: f.git('rev-parse', 'HEAD') }, f.directory),
          /README changes are not/,
        )
      }
      f.git('reset', '--hard', compare)
      rmSync(join(f.cwd, 'README.md'))
      symlinkSync('elsewhere', join(f.cwd, 'README.md'))
      f.git('add', 'README.md')
      f.git('commit', '--amend', '--no-edit', '-q')
      await assert.rejects(
        collectReview(f.cwd, { ...evidence, compare: f.git('rev-parse', 'HEAD') }, f.directory),
        /only add or modify screenshot evidence|regular file/,
      )
      assert.equal(
        parseReviewPacket(readFileSync(join(f.directory, 'current.json'), 'utf8')).evidence.compare,
        compare,
      )
    } finally {
      f.dispose()
    }
  })

  it('records through the CLI and reports blockers without changing Git or approving anything', async () => {
    const f = fixture()
    try {
      await collectReview(f.cwd, f.evidence, f.directory)
      const head = f.git('rev-parse', 'HEAD')
      await screenshotReview(
        [
          'record',
          '--pr',
          '42',
          '--item',
          'candidate/a.png',
          '--classification',
          'breakage',
          '--note',
          'Button clipped',
        ],
        f.cwd,
      )
      await screenshotReview(['status', '--pr', '42'], f.cwd)
      assert.match(readFileSync(join(f.directory, 'review.md'), 'utf8'), /breakage.*Button clipped/)
      assert.equal(f.git('rev-parse', 'HEAD'), head)
      assert.equal(loadReviewLedger(f.directory).receipts.length, 1)
    } finally {
      f.dispose()
    }
  })
})
