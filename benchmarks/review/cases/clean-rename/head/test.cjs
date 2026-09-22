const assert = require('node:assert/strict')
const { greet } = require('./src/greet.cjs')
assert.equal(greet('Ada'), 'Hello, Ada')
console.log('ok')
