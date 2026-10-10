export const AUTOMATION_ACTIVE_ATTRIBUTE = 'data-automation-active'

/** Mark the lifetime of a test-controlled app, independently of scheduled jobs. */
export function attachAutomationAppearance(
  testAutomation: boolean,
  root: HTMLElement = document.documentElement,
): () => void {
  root.toggleAttribute(AUTOMATION_ACTIVE_ATTRIBUTE, testAutomation)
  return () => {
    root.removeAttribute(AUTOMATION_ACTIVE_ATTRIBUTE)
  }
}
