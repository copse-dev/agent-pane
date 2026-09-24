const assert = require('node:assert/strict')
const { create } = require('./src/state.cjs')
;(async () => { let calls=0; create(()=>calls++).keydown({key:'l',metaKey:true,repeat:false}); assert.equal(calls, 1) })().catch(error => { console.error(error); process.exitCode = 1 })
