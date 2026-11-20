import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig, readAllowedSandboxOverlay, workspaceSandboxOverlay } from './config.ts'

it(
  'enforces external read grants in the real macOS sandbox',
  {
    skip: process.platform !== 'darwin',
    timeout: 60_000,
  },
  async () => {
    // A temp-directory fixture cannot reproduce the home deny: ASRT already
    // allows those reads. Only synthetic files in a private home directory are
    // used; never probe the user's real documents or credentials.
    const external = realpathSync(mkdtempSync(join(homedir(), '.copse-read-grant-test-')))
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'read-grant-workspace-')))
    const granted = join(external, 'approved')
    const file = join(granted, 'note.txt')
    const sibling = join(external, 'sibling.txt')
    mkdirSync(granted)
    writeFileSync(file, 'approved fixture\n')
    writeFileSync(sibling, 'unapproved fixture\n')
    symlinkSync(file, join(granted, 'internal-link'))
    symlinkSync(sibling, join(granted, 'external-link'))
    symlinkSync(granted, join(external, 'directory-alias'))
    const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
    try {
      await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
      const run = async (
        command: string,
        targets: string[] = [],
      ): Promise<{ status: number | null; output: string }> => {
        const config = targets.length
          ? readAllowedSandboxOverlay(workspace, targets)
          : workspaceSandboxOverlay(workspace)
        const { argv } = await SandboxManager.wrapWithSandboxArgv(command, '/bin/sh', config)
        const [executable = '', ...args] = argv
        const result = spawnSync(executable, args, {
          cwd: workspace,
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        assert.ifError(result.error)
        return { status: result.status, output: `${result.stdout}${result.stderr}` }
      }
      const denied = async (command: string, targets: string[] = []): Promise<void> => {
        const result = await run(command, targets)
        assert.notEqual(result.status, 0, `unexpected access: ${command}\n${result.output}`)
        assert.match(result.output, /Operation not permitted|Permission denied|EPERM|EACCES/i)
      }
      const readable = async (path: string, targets: string[]): Promise<void> => {
        const result = await run(`/bin/cat ${quote(path)}`, targets)
        assert.equal(result.status, 0, result.output)
        assert.equal(result.output, 'approved fixture\n')
      }
      await denied(`/bin/cat ${quote(file)}`)
      await readable(file, [file])
      await readable(file, [granted])
      await readable(join(granted, 'internal-link'), [granted])
      await readable(join(external, 'directory-alias', 'note.txt'), [
        join(external, 'directory-alias'),
      ])
      await denied(`/bin/cat ${quote(sibling)}`, [file])
      await denied(`/bin/cat ${quote(sibling)}`, [granted])
      await denied(`/bin/cat ${quote(join(granted, 'external-link'))}`, [granted])
      await denied(`printf changed > ${quote(file)}`, [granted])
      assert.equal(readFileSync(file, 'utf8'), 'approved fixture\n')
      // Bind a socket rather than contacting a network service: deterministic,
      // offline, and demonstrates that read consent cannot grant networking.
      await denied(
        `${quote(process.execPath)} -e ${quote("require('node:net').createServer().listen(0, '127.0.0.1')")}`,
        [granted],
      )
      await denied(`/bin/cat ${quote(file)}`)
    } finally {
      await SandboxManager.reset()
      rmSync(external, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)
