import { $, expect } from '@wdio/globals'

/** Reach project-specific controls through the default thread sidebar. */
export async function openProjectManager(): Promise<void> {
  const manager = $('.thread-project-manager')
  if (await manager.isDisplayed()) return
  const projects = $('.thread-browser-manage')
  await projects.waitForClickable({ timeout: 30_000 })
  await projects.click()
  await expect(manager).toBeDisplayed()
}
