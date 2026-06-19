import { _electron as electron, test, expect } from '@playwright/test'

test('app opens and shows layout landmarks', async () => {
  const app = await electron.launch({ args: ['dist/main/index.js'] })
  const win = await app.firstWindow()
  await expect(win.locator('#app')).toBeVisible()
  await app.close()
})
