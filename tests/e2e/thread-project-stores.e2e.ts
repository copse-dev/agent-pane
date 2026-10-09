import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import {
  e2eKnowledgeDir,
  resetUserData,
  seedStableWorkspace,
  seedTwoProjectStoresFixture,
} from './helpers/seed-config.ts'

/**
 * A turn keeps writing to its own project's stores after the window switches
 * to another project (docs: project-namespace.ts). The memory tool call is
 * held until project B is active, then released; the note must land under
 * project A's id, A's pre-id path-hash directory must migrate there with it,
 * and project B's store must be untouched.
 */

const PROJECT_A = 'e2e-stores-project-a'
const PROJECT_B = 'e2e-stores-project-b'
const THREAD_A = 'e2e-stores-thread-a'
const PROMPT = 'Remember that this project releases from the beta channel.'
const TITLE = 'Background turn release channel'
const REPLY = 'Saved the release-channel convention for this project.'

/** The pre-#1709 directory name: slug of the folder plus a hash of its path. */
function legacyName(root: string): string {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return `${slug || 'workspace'}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`
}

/** Every file under `dir` whose contents include `text`, relative to `dir`. */
function filesContaining(dir: string, text: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (readFileSync(path, 'utf8').includes(text)) found.push(path.slice(dir.length + 1))
  }
  return found
}

describe('project stores follow the turn, not the window', function () {
  this.timeout(120_000)
  let projectA = ''
  let projectB = ''

  before(async () => {
    resetUserData()
    projectA = seedStableWorkspace()
    projectB = mkdtempSync(join(tmpdir(), 'copse-e2e-stores-b-'))
    writeFileSync(join(projectB, 'README.md'), '# Project B\n')

    const knowledge = e2eKnowledgeDir()
    rmSync(knowledge, { recursive: true, force: true })
    // A still has its data under the old path-hash name; B is already id-keyed.
    mkdirSync(join(knowledge, legacyName(projectA)), { recursive: true })
    writeFileSync(join(knowledge, legacyName(projectA), 'legacy-marker.md'), 'project A legacy\n')
    mkdirSync(join(knowledge, PROJECT_B), { recursive: true })
    writeFileSync(join(knowledge, PROJECT_B, 'b-marker.md'), 'project B data\n')

    seedTwoProjectStoresFixture({
      a: { id: PROJECT_A, path: projectA, name: 'Project A' },
      b: { id: PROJECT_B, path: projectB, name: 'Project B' },
      threadId: THREAD_A,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    rmSync(projectB, { recursive: true, force: true })
    resetUserData()
  })

  it("writes a held turn's memory to its own project after switching to another", async () => {
    const scenario = await installMockScenario({
      title: 'Remember a convention from a background turn',
      turns: [
        {
          user: PROMPT,
          responses: [
            {
              waitFor: 'project-b-active',
              toolCalls: [
                {
                  name: 'remember',
                  args: { title: TITLE, content: 'Releases go out on the beta channel.' },
                },
              ],
            },
            { text: REPLY, expectToolResults: [{ name: 'remember', includes: 'Saved memory' }] },
          ],
        },
      ],
    })

    await setComposerValue(PROMPT)
    await submitComposer()
    await scenario.waitForHold('project-b-active')

    // The user moves to another project while the turn is still running.
    await $('.project-row*=Project B').click()
    await browser.waitUntil(
      async () => (await $('.project-row.active .project-name').getText()) === 'Project B',
      { timeout: 15_000, timeoutMsg: 'expected Project B to become active' },
    )
    await scenario.release('project-b-active')
    await scenario.waitForComplete(30_000)
    await scenario.assertComplete()

    const knowledge = e2eKnowledgeDir()
    // The memory is A's, under A's id — never B's, never a path-hash name.
    const written = filesContaining(knowledge, TITLE)
    assert.ok(written.length > 0, 'the remember call wrote a note')
    for (const file of written) {
      assert.ok(file.startsWith(`${PROJECT_A}/`), `${file} should be under ${PROJECT_A}`)
    }
    // A's legacy directory migrated under its id with the new note.
    assert.ok(existsSync(join(knowledge, PROJECT_A, 'legacy-marker.md')), 'legacy data migrated')
    assert.equal(existsSync(join(knowledge, legacyName(projectA))), false, 'legacy name retired')
    // Nothing else was created: no path-hash directory for either project.
    assert.deepEqual(readdirSync(knowledge).sort(), [PROJECT_A, PROJECT_B].sort())
    // B's store is untouched.
    assert.deepEqual(readdirSync(join(knowledge, PROJECT_B)), ['b-marker.md'])
  })
})
