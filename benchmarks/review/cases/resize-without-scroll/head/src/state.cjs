exports.create = (host) => {
  let viewBox = [0, 0, host.width, host.height]
  let lastX = 0, lastY = 0
  return {
    kick(x, y) {
      if (x === lastX && y === lastY) return
      lastX = x; lastY = y
      viewBox = [x, y, host.width, host.height]
    },
    viewBox() { return viewBox },
  }
}
