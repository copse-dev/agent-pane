import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { OpenAiAgentsApi } from '../src/main/services/remote/openai-agents-api.ts'
import { probeRepository, deleteRepositoryProbe } from './openai-repository-probe.mts'

it('refuses diagnostic checkpoint reuse and conflicting modes before any API call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-cli-'))
  try {
    const entry = join(root, 'probe.mjs')
    await build({
      entryPoints: [resolve('scripts/probe-openai-agents.mts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
    })
    const checkpoint = join(root, 'state.json')
    const original = JSON.stringify({ kind: 'repository-probe', sourceFileIds: [] })
    writeFileSync(checkpoint, original)
    const preload = join(root, 'no-network.mjs')
    writeFileSync(
      preload,
      "globalThis.fetch = () => { throw new Error('UNEXPECTED NETWORK REQUEST') }",
    )
    for (const args of [
      ['--setup-repository', '.', '--state', checkpoint],
      ['--prompt', 'hello', '--state', checkpoint],
      ['--setup-repository', '.', '--setup-only'],
    ]) {
      const result = spawnSync(process.execPath, ['--import', preload, entry, ...args], {
        encoding: 'utf8',
        env: { ...process.env, OPENAI_API_KEY: 'test-key' },
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /fresh --state path|Invalid saved session state|Choose only one/)
      assert.ok(!result.stderr.includes('UNEXPECTED NETWORK REQUEST'))
      assert.equal(readFileSync(checkpoint, 'utf8'), original)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reports fixed worker failure markers without persisting raw stderr or secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-markers-'))
  try {
    const worker = join(root, 'diagnostic.cjs')
    await build({
      entryPoints: [resolve('scripts/openai-setup-diagnostic-worker.mts')],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    })
    for (const [name, source, marker] of [
      ['success', '', '05-snapshot-verified'],
      [
        'download',
        "console.error('Repository setup failed while downloading the GitHub archive (HTTP 403). secret=https://private.invalid/?token=secret'); process.exit(1)",
        'failed-download',
      ],
      ['runtime', "throw new Error('secret-bearer-token')", 'failed-worker-runtime-or-assembly'],
      [
        'tree',
        "console.error('Repository setup failed while verifying the pinned archive tree.'); process.exit(1)",
        'failed-archive-tree',
      ],
    ]) {
      assert.ok(name && source !== undefined && marker)
      const workspace = join(root, name)
      mkdirSync(join(workspace, 'inputs'), { recursive: true })
      writeFileSync(join(workspace, 'inputs/archive.json'), '{}')
      writeFileSync(join(workspace, 'inputs/copse-git.cjs'), source)
      const result = spawnSync(
        process.execPath,
        [worker, workspace, 'a'.repeat(40), 'refs/copse/carry-in/abc', '0'],
        { encoding: 'utf8' },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout + result.stderr, '')
      const markers = readdirSync(join(workspace, 'copse-diagnostics'))
      assert.ok(markers.includes(marker))
      if (name === 'download') assert.ok(markers.includes('http-403'))
      for (const file of markers) {
        assert.ok(!file.includes('secret'))
        assert.equal(readFileSync(join(workspace, 'copse-diagnostics', file), 'utf8'), '')
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('provisions the real snapshot without inference and cleans sessions, files and Git refs on success or failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repository-probe-'))
  const previousToken = process.env['GH_TOKEN']
  process.env['GH_TOKEN'] = 'host-only-token'
  const previousExitCode = process.exitCode
  try {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repo, 'code.txt'), 'base')
    git('add', '.')
    git('commit', '-m', 'base')
    git('remote', 'add', 'origin', 'https://github.com/example/project.git')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    writeFileSync(join(repo, 'code.txt'), 'local changes')
    const original = git('status', '--porcelain')
    writeFileSync(join(root, 'openai-probe-git-worker.cjs'), '')
    writeFileSync(join(root, 'openai-probe-diagnostic-worker.cjs'), '')
    for (const mode of ['success', 'download-failure', 'connection-failure', 'cleanup-failure']) {
      const requests: string[] = []
      let refuseCleanup = mode === 'cleanup-failure'
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        const operation = `${init?.method ?? 'GET'} ${url.pathname}`
        requests.push(operation)
        if (url.host === 'api.github.com') {
          assert.ok(init)
          assert.equal(init.redirect, 'manual')
          assert.equal(new Headers(init.headers).get('authorization'), 'Bearer host-only-token')
          return new Response(null, {
            status: 302,
            headers: {
              location: 'https://codeload.github.com/example/project/archive?token=temporary',
            },
          })
        }
        if (operation === 'POST /v1/files') return Response.json({ id: 'file_source' })
        if (operation === 'POST /v1/agents/sessions') {
          if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
          assert.ok(!init.body.includes('host-only-token'))
          assert.ok(init.body.includes('copse-diagnostic.cjs'))
          return Response.json({
            id: 'sess_probe',
            status: 'idle',
            environment: { id: 'env_probe' },
          })
        }
        if (operation === 'GET /v1/agents/sessions/sess_probe/events') return Response.json({})
        if (operation === 'GET /v1/agents/environments/env_probe')
          return Response.json(
            mode === 'connection-failure'
              ? { status: 'failed', error: { message: 'The environment failed to connect.' } }
              : { status: 'connected' },
          )
        if (operation === 'GET /v1/agents/environments/env_probe/files') {
          assert.equal(url.searchParams.get('path'), '/workspace/copse-diagnostics')
          return Response.json({
            data: [
              {
                path: `/workspace/copse-diagnostics/${mode === 'download-failure' ? 'failed-download' : '05-snapshot-verified'}`,
              },
            ],
            has_more: false,
          })
        }
        if (
          operation === 'DELETE /v1/agents/sessions/sess_probe' ||
          operation === 'DELETE /v1/files/file_source'
        )
          return refuseCleanup
            ? Response.json({ error: { message: 'Unavailable' } }, { status: 503 })
            : new Response(null, { status: 204 })
        throw new Error(`Unexpected API request: ${operation}`)
      }
      const client = new OpenAiAgentsApi('test-key', fetchImpl)
      const statePath = join(root, `${mode}.json`)
      const run = probeRepository({
        root: repo,
        statePath,
        model: 'test-model',
        client,
        signal: AbortSignal.timeout(10_000),
        bundleDirectory: root,
        fetchImpl,
      })
      if (mode === 'download-failure' || mode === 'connection-failure')
        await assert.rejects(run, /diagnostic failed|environment failed to connect/)
      else await run
      if (mode === 'cleanup-failure') {
        assert.ok(existsSync(statePath))
        assert.equal(process.exitCode, 1)
        refuseCleanup = false
        assert.equal(await deleteRepositoryProbe(statePath, client), true)
      }
      assert.ok(existsSync(`${statePath}.deleted`))
      assert.ok(!existsSync(statePath))
      assert.ok(requests.includes('DELETE /v1/files/file_source'))
      assert.ok(requests.includes('DELETE /v1/agents/sessions/sess_probe'))
      assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/copse/openai'), '')
      assert.equal(git('status', '--porcelain'), original)
    }
  } finally {
    if (previousToken === undefined) delete process.env['GH_TOKEN']
    else process.env['GH_TOKEN'] = previousToken
    process.exitCode = previousExitCode
    rmSync(root, { recursive: true, force: true })
  }
})
