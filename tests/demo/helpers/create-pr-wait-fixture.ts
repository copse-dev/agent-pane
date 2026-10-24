import { openCreatePrDialog } from '../../../src/renderer/views/create-pr-dialog.ts'

let release: () => void = () => {}
const bodyPromise = new Promise<string>((resolve) => {
  release = (): void => {
    resolve('Generated description kept after confirmation.')
  }
})
const result = document.createElement('output')
result.id = 'fixture-result'
result.hidden = true
result.dataset['status'] = 'pending'
document.body.append(result)
document.addEventListener('release-description', () => {
  release()
})
void openCreatePrDialog({
  suggestedTitle: 'Preserve the generated PR description',
  branch: 'codex/description-ready',
  bodyPromise,
}).then((choice) => {
  result.dataset['status'] = choice ? 'confirmed' : 'cancelled'
  if (choice) {
    result.dataset['title'] = choice.title
    result.dataset['body'] = choice.body
  }
})
