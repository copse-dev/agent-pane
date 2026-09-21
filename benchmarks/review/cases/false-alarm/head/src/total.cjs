// The sum of a list of prices.
function total(prices) {
  if (prices.length === 0) return 0
  return prices.reduce((sum, price) => sum + price, 0)
}
module.exports = { total }
