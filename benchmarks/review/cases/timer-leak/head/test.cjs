const assert = require('node:assert/strict')
const { delay } = require('./src/timer.cjs')
delay('value', 5, new AbortController().signal).then((value) => {
  assert.equal(value, 'value')
  console.log('ok')
})
