// Resolve with the value after a delay, or reject when the signal aborts.
function delay(value, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms)
    signal.addEventListener('abort', () => {
      reject(new Error('aborted'))
    })
  })
}
module.exports = { delay }
