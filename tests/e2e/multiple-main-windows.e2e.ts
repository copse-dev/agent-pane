import { mkdirSync } from 'node:fs'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedProjectSwitchFixture } from './helpers/seed-config.ts'

interface MultiWindowBridge {
  createMainWindow(): Promise<void>
}

describe('multiple main windows', function () {
  this.timeout(90_000)
  let primaryHandle: string | undefined
  let secondaryHandle: string | undefined

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedProjectSwitchFixture(process.cwd(), {
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
    await $('#app').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('opens a second complete Copse window', async () => {
    primaryHandle = (await browser.getWindowHandles())[0]
    if (!primaryHandle) throw new Error('Main window handle unavailable')
    const mainHandle = primaryHandle

    const before = await browser.getWindowHandles()
    await browser.execute(async () => {
      const bridge = (window as unknown as { __copseE2e?: MultiWindowBridge }).__copseE2e
      if (!bridge?.createMainWindow) {
        throw new Error('__copseE2e.createMainWindow unavailable')
      }
      await bridge.createMainWindow()
    })

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'Second main window did not open',
    })
    secondaryHandle = (await browser.getWindowHandles()).find((handle) => !before.includes(handle))
    if (!secondaryHandle) throw new Error('Secondary window handle unavailable')

    await browser.switchToWindow(secondaryHandle)
    await $('#app').waitForDisplayed({ timeout: 30_000 })
    await $('#pane-projects').waitForExist({ timeout: 30_000 })
    await $('#pane-chat').waitForExist({ timeout: 30_000 })
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const projectB = await $('.project-row*=Project B')
    await projectB.click()
    await browser.waitUntil(
      async () => (await $('.project-row.active .project-name').getText()) === 'Project B',
      {
        timeout: 15_000,
        timeoutMsg: 'Secondary window did not activate Project B',
      },
    )
    await saveAppScreenshot('multiple-main-windows-secondary.png')

    await browser.switchToWindow(mainHandle)
    await $('#app').waitForDisplayed({ timeout: 10_000 })
    await expect($('.project-row.active .project-name')).toHaveText('Project A')
    await expect(await browser.getWindowHandles()).toContain(mainHandle)
  })

  it('restores each window with its own selected project', async () => {
    await browser.reloadSession()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'Both persisted main windows were not restored',
    })

    const handles = await browser.getWindowHandles()
    const selections: Array<{ handle: string; project: string }> = []
    for (const handle of handles) {
      await browser.switchToWindow(handle)
      await $('#app').waitForDisplayed({ timeout: 30_000 })
      selections.push({
        handle,
        project: await $('.project-row.active .project-name').getText(),
      })
    }
    expect(selections.map(({ project }) => project).sort()).toEqual(['Project A', 'Project B'])

    const projectBHandle = selections.find(({ project }) => project === 'Project B')?.handle
    const projectAHandle = selections.find(({ project }) => project === 'Project A')?.handle
    if (!projectAHandle || !projectBHandle) throw new Error('Restored project windows unavailable')
    await browser.switchToWindow(projectBHandle)
    await browser.closeWindow()
    await browser.switchToWindow(projectAHandle)
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
      timeout: 10_000,
      timeoutMsg: 'Secondary main window did not close',
    })
  })
})
