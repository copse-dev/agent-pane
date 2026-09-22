function screenshotImage(dataUrl) {
  return { dataUrl, name: 'screen.png', kind: 'screenshot' }
}

function renderClass(image) {
  return image.kind === 'screenshot' ? 'reading-size' : 'thumbnail'
}

module.exports = { renderClass, screenshotImage }
