import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalChoiceJudge } from './lib/roadmap-judge-local.mts'

const fixture = `
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ready:true,model:'fixture-only',setupMs:0,details:{fixture:true}}));
for await (const line of createInterface({input:process.stdin})) {
  const payload = JSON.parse(line);
  if (Object.hasOwn(payload, 'label') || Object.hasOwn(payload, 'expected')) process.exit(3);
  console.log(JSON.stringify({verdict:'sandbox',probabilities:{sandbox:1,external:0},model:'fixture-only',usage:null,error:null,fatal:false}));
}
`
const payload = {
  state: { command: 'DO_NOT_EXECUTE_fixture_text' },
  questions: {
    resolution: {
      type: 'choice',
      instructions: 'Choose scope.',
      criteria: { sandbox: 'Contained', external: 'Outside' },
    },
  },
}

test('actual JSONL process boundary sends command text as data and validates the native reply', async () => {
  const worker = new LocalChoiceJudge(
    process.execPath,
    ['--input-type=module', '-e', fixture],
    3000,
  )
  try {
    assert.equal((await worker.ready()).model, 'fixture-only')
    const result = await worker.evaluatePayload(payload, ['sandbox', 'external'])
    assert.equal(result.error, null)
    assert.equal(result.verdict, 'sandbox')
    assert.deepEqual(result.probabilities, { sandbox: 1, external: 0 })
  } finally {
    worker.close()
  }
})

test('invalid native distributions remain errors rather than confident predictions', async () => {
  const worker = new LocalChoiceJudge(
    process.execPath,
    ['--input-type=module', '-e', fixture.replace('sandbox:1,external:0', 'sandbox:1,external:1')],
    3000,
  )
  try {
    await worker.ready()
    const result = await worker.evaluatePayload(payload, ['sandbox', 'external'])
    assert.equal(result.verdict, null)
    assert.equal(result.probabilities, null)
    assert.match(result.error, /Invalid local judgment/)
  } finally {
    worker.close()
  }
})
