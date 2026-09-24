const assert = require('node:assert/strict')
const { create } = require(require('node:path').resolve(process.argv[2], 'src/state.cjs'))
;(async () => { const view=create(); let finish; const pending=view.refresh(()=>new Promise(resolve=>{finish=resolve})); view.dispose(); finish(['late result']); await pending; assert.deepEqual(view.rows(), []) })().catch(error => { console.error(error); process.exitCode = 1 })
