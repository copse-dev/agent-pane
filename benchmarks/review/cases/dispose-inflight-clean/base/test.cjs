const assert = require('node:assert/strict')
const { create } = require('./src/state.cjs')
;(async () => { const view=create(); await view.refresh(async()=>['current']); view.dispose(); assert.deepEqual(view.rows(), []) })().catch(error => { console.error(error); process.exitCode = 1 })
