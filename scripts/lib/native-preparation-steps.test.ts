import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nativePreparationSteps } from './native-preparation-steps.mts'

describe('native runtime preparation order', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    it(`prepares Electron before native modules on ${platform}`, () => {
      const paths = nativePreparationSteps(platform).map((step) => step.path)
      const runtime =
        platform === 'darwin' ? 'scripts/patch-dev-name.mts' : 'node_modules/electron/install.js'
      assert.ok(paths.indexOf(runtime) >= 0)
      assert.ok(paths.indexOf(runtime) < paths.indexOf('scripts/postinstall-native.mts'))
      assert.equal(paths.includes('node_modules/electron/install.js'), platform !== 'darwin')
    })
  }

  it('generates the app icon before patching the dev bundle on darwin', () => {
    const steps = nativePreparationSteps('darwin')
    const paths = steps.map((step) => step.path)
    const iconIndex = paths.indexOf('scripts/generate-icon.mts')
    assert.ok(iconIndex >= 0)
    assert.ok(iconIndex < paths.indexOf('scripts/patch-dev-name.mts'))
    assert.equal(steps[iconIndex]?.required, false)
  })

  it('does not generate the app icon on non-macOS platforms', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const paths = nativePreparationSteps(platform).map((step) => step.path)
      assert.ok(!paths.includes('scripts/generate-icon.mts'))
    }
  })
})
