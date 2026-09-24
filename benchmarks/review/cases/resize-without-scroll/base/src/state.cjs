exports.create = (host) => {
  let viewBox = [0, 0, host.width, host.height]
  return {
    kick(x, y) { viewBox = [x, y, host.width, host.height] },
    viewBox() { return viewBox },
  }
}
