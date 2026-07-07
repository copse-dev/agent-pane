const assert = require('node:assert')
const { sumTo } = require('./sum.js')

assert.strictEqual(sumTo(1), 1, 'sumTo(1) should be 1')
assert.strictEqual(sumTo(5), 15, 'sumTo(5) should be 15')
assert.strictEqual(sumTo(10), 55, 'sumTo(10) should be 55')
console.log('ok')
