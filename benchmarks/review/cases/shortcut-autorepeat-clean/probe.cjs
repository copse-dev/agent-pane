const assert = require('node:assert/strict')
const { create } = require(require('node:path').resolve(process.argv[2], 'src/state.cjs'))
;(async () => { let calls=0; const view=create(()=>calls++); view.keydown({key:'l',metaKey:true,repeat:false}); view.keydown({key:'l',metaKey:true,repeat:true}); assert.equal(calls, 1) })().catch(error => { console.error(error); process.exitCode = 1 })
