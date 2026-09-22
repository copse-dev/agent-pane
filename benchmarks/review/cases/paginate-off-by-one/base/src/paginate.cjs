// Slice one page out of a list. Pages are 1-based.
function paginate(items, page, size) {
  const start = (page - 1) * size
  return items.slice(start, start + size)
}
module.exports = { paginate }
