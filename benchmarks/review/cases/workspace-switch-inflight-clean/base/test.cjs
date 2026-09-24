const assert = require('node:assert/strict')
const { create } = require('./src/state.cjs')
;(async () => { const view=create(); await view.open(async()=>['current']); assert.deepEqual(view.rows(), ['current']) })().catch(error => { console.error(error); process.exitCode = 1 })
