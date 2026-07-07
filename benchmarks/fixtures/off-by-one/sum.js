// Sums the integers 1..n inclusive.
function sumTo(n) {
  let total = 0
  for (let i = 1; i < n; i++) total += i
  return total
}

module.exports = { sumTo }
