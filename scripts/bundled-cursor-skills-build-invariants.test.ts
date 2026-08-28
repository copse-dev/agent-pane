import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  BUNDLED_CURSOR_PLUGINS_COMMIT,
  assertBundledCursorSkillsSnapshot,
} from './bundled-cursor-skills-sync.mts'

const build = readFileSync('scripts/build.mts', 'utf8')
const manifest = readFileSync('package.json', 'utf8')
const gitignore = readFileSync('.gitignore', 'utf8')
const prettierIgnore = readFileSync('.prettierignore', 'utf8')

describe('hermetic bundled Cursor skills', () => {
  it('never fetches during install or build', () => {
    assert.doesNotMatch(manifest, /postinstall[^\n]+(?:fetch|sync)-bundled-cursor-skills/)
    assert.doesNotMatch(build, /fetchBundledCursorSkills|SKIP_BUNDLED_CURSOR_SKILLS_FETCH/)
    assert.doesNotMatch(build, /execSync\([^\n]+cursor-skills/)
  })

  it('validates and unconditionally copies the tracked snapshot', () => {
    assert.match(build, /await assertBundledCursorSkillsSnapshot\(\)/)
    assert.match(
      build,
      /cpSync\(BUNDLED_CURSOR_SKILLS_VENDOR_DIR, 'dist\/resources\/bundled-cursor-skills'/,
    )
    assert.doesNotMatch(gitignore, /^vendor\/bundled-cursor-skills\/$/m)
    assert.match(prettierIgnore, /^vendor\/bundled-cursor-skills\/plugins\/$/m)
  })

  it('keeps network access behind the explicit sync command', () => {
    assert.match(manifest, /"sync:cursor-skills": "node scripts\/sync-bundled-cursor-skills\.mts"/)
  })

  it('ships a complete snapshot at the source-pinned commit', async () => {
    const source = await assertBundledCursorSkillsSnapshot()
    assert.equal(source.commit, BUNDLED_CURSOR_PLUGINS_COMMIT)
    assert.equal(source.pluginCount, 13)
    assert.equal(source.skillCount, 71)
  })
})
