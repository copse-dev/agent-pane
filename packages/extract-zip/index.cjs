'use strict'

// electron-chromedriver 43.x still requires extract-zip from CommonJS during
// installation. Keep that callable surface while delegating extraction to the
// maintained ESM-only implementation.
const extractPromise = import('@electron-internal/extract-zip').then(
  ({ default: extract }) => extract,
)

module.exports = async function extractZip(zipPath, options) {
  const extract = await extractPromise
  return extract(zipPath, options)
}
