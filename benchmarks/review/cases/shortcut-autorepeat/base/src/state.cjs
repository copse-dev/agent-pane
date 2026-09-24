exports.create = (share) => ({
  keydown(event) {
    if (event.key !== 'l' || !event.metaKey || event.repeat) return
    share()
  },
})
