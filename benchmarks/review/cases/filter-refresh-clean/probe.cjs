const assert = require('node:assert/strict')
const { create } = require(require('node:path').resolve(process.argv[2], 'src/state.cjs'))
;(async () => { const view = create(); assert.equal(view.render('Anchor').length, 1); view.refresh(); assert.equal(view.render('Anchor').length, 1) })().catch(error => { console.error(error); process.exitCode = 1 })
