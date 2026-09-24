const assert = require('node:assert/strict')
const { create } = require(require('node:path').resolve(process.argv[2], 'src/state.cjs'))
;(async () => { const view=create(); let finish; const old=view.open(()=>new Promise(resolve=>{finish=resolve})); await view.open(async()=>['new workspace']); finish(['old workspace']); await old; assert.deepEqual(view.rows(), ['new workspace']) })().catch(error => { console.error(error); process.exitCode = 1 })
