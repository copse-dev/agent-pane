import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mountRemoteDecisions, remoteDecisionSchema, type DecisionAnswer } from './decisions.ts'
import { qsRequired } from '../dom/helpers.ts'

test('remote questions retain drafts across polls/disconnection and submit every answer', async () => {
  const root = document.createElement('div')
  const answers: DecisionAnswer[] = []
  const mount = mountRemoteDecisions(root, async (answer) => {
    answers.push(answer)
  })
  const decision = remoteDecisionSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'question',
    questions: [{ question: 'Which test?', options: ['Focused'] }, { question: 'Why?' }],
  })
  mount.update([decision], true)
  const input = qsRequired<HTMLTextAreaElement>(root, 'textarea')
  input.value = 'My draft'
  mount.update([decision], false)
  assert.equal(input.disabled, true)
  mount.update([decision], true)
  assert.equal(qsRequired(root, 'textarea'), input)
  assert.equal(input.value, 'My draft')
  const button = [...root.querySelectorAll('button')].find(
    (node) => node.textContent === 'Send answers',
  )
  assert.ok(button)
  button.click()
  await Promise.resolve()
  assert.deepEqual(answers, [
    { action: 'answer', decisionId: decision.id, answers: ['My draft', ''] },
  ])
  mount.update([], true)
  assert.equal(root.querySelector('textarea'), null)
})

test('remote approval renders untrusted body as text and disables duplicate or disconnected decisions', async () => {
  const root = document.createElement('div')
  const answers: DecisionAnswer[] = []
  let release: () => void = () => {}
  const mount = mountRemoteDecisions(root, async (answer) => {
    answers.push(answer)
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  const decision = remoteDecisionSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'approval',
    title: 'Run command',
    body: '<img src=x onerror=alert(1)>',
    advice: 'Once only',
    footer: 'No remembered grant',
  })
  mount.update([decision], true)
  assert.equal(root.querySelector('img'), null)
  assert.equal(decision.kind, 'approval')
  assert.equal(root.querySelector('pre')?.textContent, '<img src=x onerror=alert(1)>')
  const deny = qsRequired<HTMLButtonElement>(root, 'button')
  deny.click()
  deny.click()
  assert.equal(answers.length, 1)
  assert.equal(deny.disabled, true)
  release()
  await Promise.resolve()
  await Promise.resolve()
  mount.update([decision], false)
  deny.click()
  assert.equal(answers.length, 1)
})
