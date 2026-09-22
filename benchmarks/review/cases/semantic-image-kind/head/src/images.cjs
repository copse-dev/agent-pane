function screenshotImage(dataUrl) {
  return { dataUrl, name: 'screen.png', kind: 'screenshot' }
}

function generatedImage(dataUrl) {
  return { dataUrl, name: 'generated.png' }
}

function renderClass(image) {
  return image.kind === 'screenshot' ? 'reading-size' : 'thumbnail'
}

module.exports = { generatedImage, renderClass, screenshotImage }
