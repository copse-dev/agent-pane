const assert = require('node:assert/strict')
const { create } = require('./src/state.cjs')
;(async () => { const layer = create({width:400,height:300}); layer.kick(1,2); assert.deepEqual(layer.viewBox(), [1,2,400,300]) })().catch(error => { console.error(error); process.exitCode = 1 })
