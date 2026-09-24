const assert = require('node:assert/strict')
const { create } = require('./src/state.cjs')
;(async () => { assert.equal(create().render('').length, 1) })().catch(error => { console.error(error); process.exitCode = 1 })
