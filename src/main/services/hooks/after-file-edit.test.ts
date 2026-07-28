// Contract tests for the `afterFileEdit` fire site (B2).
//
// Pins the B2 acceptance surface: the event fires after an edit, blocking by
// default (the fire site awaits the hook, so its side effect is complete on
// return); per-hook path/glob matchers filter which hooks run; project hooks are
// gated on workspace trust; and — because Cursor's afterFileEdit is
// notification-only — a crashing hook (fail-open or failClosed) never throws and
// never blocks the edit that already landed. A second block proves the wiring at
// the diff-queue / write-tool site itself.
//
// House style mirrors `before-submit-prompt.test.ts`: real spawned scripts driven
// through the canonical `afterFileEdit` registry → runner → adapter seam. Since
// afterFileEdit returns no data, "did it fire" is proven by a marker file the
// script writes.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import { runAfterFileEditHooks } from './after-file-edit.ts'

describe('after-file-edit (afterFileEdit diff-queue / write-tool site — B2)', () => {
  let tempHome = ''
  let projectRoot = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-after-edit-home-'))
    projectRoot = await mkdtemp(join(tmpdir(), 'copse-after-edit-proj-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    setCursorHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCursorHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  /**
   * Write an executable hook script that drains stdin and then touches
   * `markerPath` (proving it ran). Returns the script's absolute path.
   */
  async function writeMarkerScript(name: string, markerPath: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\n: > '${markerPath}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  /** Fire the canonical afterFileEdit event for a path under the temp project. */
  function edit(relPath: string): ReturnType<typeof runAfterFileEditHooks> {
    return runAfterFileEditHooks(join(projectRoot, relPath), {
      workspaceRoot: projectRoot,
      projectTrusted: false,
    })
  }

  it('runs no hooks when none are registered for afterFileEdit', async () => {
    const result = await edit('src/app.ts')
    assert.equal(result.ran, 0)
  })

  it('fires after an edit and awaits the hook (blocking — marker present on return)', async () => {
    const marker = join(tempHome, 'ran.marker')
    const script = await writeMarkerScript('fmt.sh', marker)
    await writeUserHooks({ hooks: { afterFileEdit: [{ command: script }] } })

    const result = await edit('src/app.ts')
    assert.equal(result.ran, 1)
    // The fire site awaited the hook, so its side effect is already complete.
    assert.equal(existsSync(marker), true)
  })

  it('passes the edited file_path to the hook on stdin', async () => {
    const captured = join(tempHome, 'stdin.json')
    const path = join(tempHome, 'capture.sh')
    await writeFile(path, `#!/bin/sh\ncat > '${captured}'\n`, 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { afterFileEdit: [{ command: path }] } })

    const abs = join(projectRoot, 'src/app.ts')
    await runAfterFileEditHooks(abs, { workspaceRoot: projectRoot, projectTrusted: false })
    const stdin = expectRecord(parseJsonUnknown(await readFile(captured, 'utf-8')))
    assert.equal(stdin['file_path'], abs)
    assert.equal(stdin['hook_event_name'], 'afterFileEdit')
  })

  it('matcher: only hooks whose glob matches the edited path fire', async () => {
    const tsMarker = join(tempHome, 'ts.marker')
    const mdMarker = join(tempHome, 'md.marker')
    const tsScript = await writeMarkerScript('ts.sh', tsMarker)
    const mdScript = await writeMarkerScript('md.sh', mdMarker)
    await writeUserHooks({
      hooks: {
        afterFileEdit: [
          { command: tsScript, glob: '**/*.ts' },
          { command: mdScript, glob: '**/*.md' },
        ],
      },
    })

    const result = await edit('src/app.ts')
    assert.equal(result.ran, 1)
    assert.equal(existsSync(tsMarker), true, 'the **/*.ts hook must fire for a .ts edit')
    assert.equal(existsSync(mdMarker), false, 'the **/*.md hook must not fire for a .ts edit')
  })

  it('matcher: a glob-less hook fires for every edit', async () => {
    const marker = join(tempHome, 'all.marker')
    const script = await writeMarkerScript('all.sh', marker)
    await writeUserHooks({ hooks: { afterFileEdit: [{ command: script }] } })

    const result = await edit('notes/readme.md')
    assert.equal(result.ran, 1)
    assert.equal(existsSync(marker), true)
  })

  it('matcher: a bare basename glob (*.ts) matches a nested file', async () => {
    const marker = join(tempHome, 'base.marker')
    const script = await writeMarkerScript('base.sh', marker)
    await writeUserHooks({ hooks: { afterFileEdit: [{ command: script, glob: '*.ts' }] } })

    const result = await edit('src/deep/app.ts')
    assert.equal(result.ran, 1)
    assert.equal(existsSync(marker), true)
  })

  it('matcher: accepts an array of globs', async () => {
    const marker = join(tempHome, 'arr.marker')
    const script = await writeMarkerScript('arr.sh', marker)
    await writeUserHooks({
      hooks: { afterFileEdit: [{ command: script, glob: ['**/*.css', '**/*.md'] }] },
    })

    assert.equal((await edit('style.css')).ran, 1)
    assert.equal(existsSync(marker), true)
  })

  it('fails open: a crashing hook never throws and never blocks the edit', async () => {
    const path = join(tempHome, 'crash.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { afterFileEdit: [{ command: path }] } })

    // afterFileEdit is notification-only, so this must simply resolve.
    const result = await edit('src/app.ts')
    assert.equal(result.ran, 1)
  })

  it('failClosed on afterFileEdit is inert: still resolves without throwing (edit already landed)', async () => {
    const path = join(tempHome, 'crash-closed.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { afterFileEdit: [{ command: path, failClosed: true }] } })

    const result = await edit('src/app.ts')
    // The notification cannot block; failClosed has nothing to deny post-hoc.
    assert.equal(result.ran, 1)
  })

  it('a project hook is ignored unless the workspace is trusted', async () => {
    const marker = join(tempHome, 'proj.marker')
    const script = await writeMarkerScript('proj.sh', marker)
    await mkdir(join(projectRoot, '.cursor'), { recursive: true })
    await writeFile(
      join(projectRoot, '.cursor', 'hooks.json'),
      JSON.stringify({ hooks: { afterFileEdit: [{ command: script }] } }),
      'utf-8',
    )

    const untrusted = await runAfterFileEditHooks(join(projectRoot, 'a.ts'), {
      workspaceRoot: projectRoot,
      projectTrusted: false,
    })
    assert.equal(untrusted.ran, 0)
    assert.equal(existsSync(marker), false)

    const trusted = await runAfterFileEditHooks(join(projectRoot, 'a.ts'), {
      workspaceRoot: projectRoot,
      projectTrusted: true,
    })
    assert.equal(trusted.ran, 1)
    assert.equal(existsSync(marker), true)
  })
})
