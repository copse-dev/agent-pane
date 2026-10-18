import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { AUDITED_NATIVE_OUTPUTS } from './native-screenshot-outputs-audit.mts'
import { nativeScreenshotOutputs } from './native-screenshot-outputs.mts'
import { SCREENSHOT_NAME } from './screenshot-manifest.mts'

const SPEC = 'tests/e2e/capture-example.e2e.ts'

describe('native screenshot output ownership', () => {
  it('parses selector parentheses and filename aliases with additional arguments', () => {
    assert.deepEqual(
      nativeScreenshotOutputs(
        SPEC,
        `const SHOT = 'panel.png'
        await saveElementScreenshot('fieldset:has(#sources-agents-list)', SHOT, { frame: 'document' })
        await saveAppViewportScreenshot('viewport.png', async () => {})`,
      ),
      ['panel.png', 'viewport.png'],
    )
  })

  it('keeps fixture strings, unused tables, callbacks and foreign destinations unowned', () => {
    assert.deepEqual(
      nativeScreenshotOutputs(
        SPEC,
        `const SHOT = 'actual.png'
        const UNUSED = 'unused.png'
        const cases = [{ screenshot: 'table.png' }]
        clickChange('staged.png')
        await saveElementScreenshot('.selector.png', SHOT)
        await saveAppViewportScreenshot(SHOT, async () => readFile('callback.png'))
        await browser.saveScreenshot(join('/tmp', 'foreign.png'))
        writeFile(join(E2E_SCREENSHOT_DIR, 'unaudited.png'), bytes)
        await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, '../escape.png'))`,
      ),
      ['actual.png'],
    )
  })

  it('recognizes an exact native directory destination without scanning other call arguments', () => {
    assert.deepEqual(
      nativeScreenshotOutputs(
        SPEC,
        `import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'
        const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
        await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'native.png'))
        await element.saveScreenshot(join(SCREENSHOT_DIR, 'element.png'))`,
      ),
      ['element.png', 'native.png'],
    )
  })

  it('does not resolve mutable or shadowed filename aliases', () => {
    assert.deepEqual(
      nativeScreenshotOutputs(
        SPEC,
        `let MUTABLE = 'mutable.png'
        const SHADOWED = 'outer.png'
        function capture(SHADOWED) { saveAppScreenshot(SHADOWED) }
        saveAppScreenshot(MUTABLE)`,
      ),
      [],
    )
  })

  it('rejects destructured shadowing and foreign directories with familiar names', () => {
    assert.deepEqual(
      nativeScreenshotOutputs(
        SPEC,
        `const SHOT = 'outer.png'
        function capture({SHOT}) { saveAppScreenshot(SHOT) }
        const SCREENSHOT_DIR = '/tmp/diagnostics'
        browser.saveScreenshot(join(SCREENSHOT_DIR, 'foreign.png'))`,
      ),
      [],
    )
    assert.deepEqual(
      nativeScreenshotOutputs(
        SPEC,
        `const SHOT = 'outer.png'
        function capture(options) { const {SHOT} = options; saveAppScreenshot(SHOT) }
        import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'
        function another({E2E_SCREENSHOT_DIR}) {
          browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'foreign.png'))
        }`,
      ),
      [],
    )
  })

  it('binds finite dynamic declarations to audited producer source and safe unique names', () => {
    const owners = new Map<string, string>()
    for (const [spec, declaration] of Object.entries(AUDITED_NATIVE_OUTPUTS)) {
      const source = readFileSync(spec, 'utf8')
      assert.equal(
        createHash('sha256').update(source).digest('hex'),
        declaration.sourceSha256,
        spec,
      )
      const outputs = nativeScreenshotOutputs(spec, source)
      for (const name of declaration.filenames) {
        assert.match(name, SCREENSHOT_NAME)
        assert.ok(outputs.includes(name), `${spec} must own ${name}`)
        assert.equal(owners.has(name), false, `${name} already owned by ${owners.get(name) ?? ''}`)
        owners.set(name, spec)
      }
    }
  })

  it('revokes declarations when a producer changes or appears under another path', () => {
    const spec = 'tests/e2e/settings-provider-hosts.e2e.ts'
    const source = readFileSync(spec, 'utf8')
    assert.ok(nativeScreenshotOutputs(spec, source).includes('settings-provider-hosts-page-2.png'))
    assert.equal(
      nativeScreenshotOutputs(spec, source + '\n').includes('settings-provider-hosts-page-2.png'),
      false,
    )
    assert.equal(
      nativeScreenshotOutputs(SPEC, source).includes('settings-provider-hosts-page-2.png'),
      false,
    )
    assert.equal(
      nativeScreenshotOutputs(spec, source).includes('settings-provider-hosts-page-9.png'),
      false,
    )
  })

  it('covers real selectors, additional arguments, table writers and direct player PNG writes', () => {
    const examples: Record<string, string[]> = {
      'tests/e2e/settings-sources-agents.e2e.ts': ['settings-sources-agents.png'],
      'tests/e2e/image-expand.e2e.ts': ['image-expand-composer-updated-chip.png'],
      'tests/e2e/malformed-tool-call-inspector.e2e.ts': ['malformed-tool-call-inspector.png'],
      'tests/e2e/thread-explainer.e2e.ts': ['thread-explainer-player.png'],
      'tests/e2e/thread-explainer-scenes.e2e.ts': [
        'explainer-scenes-1-player.png',
        'explainer-scenes-2.png',
      ],
    }
    for (const [spec, names] of Object.entries(examples)) {
      const outputs = nativeScreenshotOutputs(spec, readFileSync(spec, 'utf8'))
      for (const name of names) assert.ok(outputs.includes(name), `${spec} must own ${name}`)
    }
  })
})
