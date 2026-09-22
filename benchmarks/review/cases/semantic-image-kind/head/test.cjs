const assert = require('node:assert/strict')
const { generatedImage, renderClass, screenshotImage } = require('./src/images.cjs')

assert.equal(renderClass(screenshotImage('data:image/png;base64,AA==')), 'reading-size')
assert.equal(generatedImage('data:image/png;base64,AQ==').dataUrl, 'data:image/png;base64,AQ==')
console.log('ok')
