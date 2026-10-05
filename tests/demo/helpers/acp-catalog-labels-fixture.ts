import { mountModelPicker } from '../../../src/renderer/views/model-picker.ts'

const app = document.querySelector('#app')
if (!app) throw new Error('Missing fixture mount')
for (const [title, value] of [
  ['Known catalog agent without configured settings', 'acp:codex-acp'],
  ['Known catalog model without configured settings', 'acp:codex-acp#gpt-5.6-sol'],
  ['Another known catalog agent', 'acp:gemini-cli'],
  ['Unknown agent retains its recorded ID', 'acp:unknown-agent'],
]) {
  const section = document.createElement('section')
  section.style.padding = '16px'
  const heading = document.createElement('h4')
  heading.textContent = title ?? ''
  const root = document.createElement('div')
  section.append(heading, root)
  app.append(section)
  // Empty option/settings context reaches the actual fallback used before settings load.
  mountModelPicker(
    root,
    () => value ?? '',
    () => {},
    async () => [],
  )
}
