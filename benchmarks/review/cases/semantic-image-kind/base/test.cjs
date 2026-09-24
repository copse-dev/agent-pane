const assert = require('node:assert/strict')
const { renderClass, screenshotImage } = require('./src/images.cjs')

assert.equal(renderClass(screenshotImage('data:image/png;base64,AA==')), 'reading-size')
console.log('ok')
