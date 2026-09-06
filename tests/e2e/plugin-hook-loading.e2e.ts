import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PLUGIN_ID = 'personal.hook-loading'
const ROW = `.plugin-row[data-plugin-id="${PLUGIN_ID}"]`

// This intentionally uses the built app and its default runtime controller,
// snapshot materializer, worker bundle and OS sandbox. No runtime dependency is
// replaced. Hook invocation is covered separately by plugin-hook-worker.test.ts;
// automatic event dispatch is not part of the registration-only SDK contract.
describe('external hook loading through Electron Settings', function () {
  this.timeout(90_000)
  let root = ''
  let outsideFile = ''

  before(async function () {
    if (process.platform !== 'darwin') this.skip()
    resetUserData()
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    root = mkdtempSync(join(tmpdir(), 'copse-e2e-hook-loading-'))
    const pluginRoot = join(root, 'plugin')
    const workspaceRoot = join(root, 'workspace')
    mkdirSync(pluginRoot)
    mkdirSync(workspaceRoot)
    outsideFile = join(root, 'outside.txt')
    writeFileSync(outsideFile, 'outside sentinel')
    writeFileSync(join(pluginRoot, 'helper.mjs'), 'export const value = "snapshot asset"\n')
    writeFileSync(join(pluginRoot, 'asset.txt'), 'snapshot asset')
    writeFileSync(
      join(pluginRoot, 'index.mjs'),
      `import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { value } from './helper.mjs';
async function mustBeDenied(operation) {
  try { await operation(); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return;
    throw error;
  }
  throw new Error('Production plugin sandbox allowed a forbidden operation');
}
export async function activate(api) {
  if (!fileURLToPath(import.meta.url).includes('/plugin-tool-snapshots/')) {
    throw new Error('Plugin did not load from the production snapshot');
  }
  if (await readFile(new URL('./asset.txt', import.meta.url), 'utf8') !== value) {
    throw new Error('Snapshot asset or sibling module failed to load');
  }
  await mustBeDenied(() => readFile(${JSON.stringify(outsideFile)}, 'utf8'));
  await mustBeDenied(() => writeFile(${JSON.stringify(join(workspaceRoot, 'forbidden.txt'))}, 'escape'));
  await mustBeDenied(() => writeFile(new URL('./asset.txt', import.meta.url), 'modified'));
  api.registerHook({ id: 'inspect', event: 'turnStart' }, input => input);
}
`,
    )
    writeFileSync(
      join(pluginRoot, 'copse-plugin.json'),
      JSON.stringify({
        name: PLUGIN_ID,
        version: '0.1.0',
        description: 'Hook loading and sandbox validation.',
        runtime: {
          entrypoint: 'index.mjs',
          apiVersion: 1,
          hooks: [{ id: 'inspect', event: 'turnStart' }],
        },
      }),
    )
    seedEmptyProject(workspaceRoot, 'e2e-hook-loading', { pluginSources: [pluginRoot] })
    await browser.reloadSession()
  })

  after(() => {
    if (!root) return
    resetUserData()
    rmSync(root, { recursive: true, force: true })
  })

  async function openPluginSettings(): Promise<void> {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    await $(ROW).waitForExist({ timeout: 15_000 })
  }

  it('loads a hook-only snapshot under seatbelt, re-enables it and restores it after relaunch', async () => {
    await openPluginSettings()
    // Enabled is set only after the worker imports activate(), the sandbox
    // probes succeed and the host validates the exact hook handshake.
    assert.equal(await $(ROW).getAttribute('data-enabled'), 'true', await $(ROW).getText())
    await $(ROW).$('label.plugin-toggle').click()
    await browser.waitUntil(async () => (await $(ROW).getAttribute('data-enabled')) === 'false')
    await $(ROW).$('label.plugin-toggle').click()
    await browser.waitUntil(async () => (await $(ROW).getAttribute('data-enabled')) === 'true')
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside sentinel')
    assert.equal(existsSync(join(root, 'workspace', 'forbidden.txt')), false)

    await browser.reloadSession()
    await openPluginSettings()
    assert.equal(await $(ROW).getAttribute('data-enabled'), 'true', await $(ROW).getText())
    await $(ROW).scrollIntoView()
    await saveElementScreenshot(ROW, 'plugin-hook-loading.png')
  })
})
