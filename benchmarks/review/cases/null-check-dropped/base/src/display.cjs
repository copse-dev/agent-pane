// The display name for a user record, or null for no user.
function displayName(user) {
  if (!user) return null
  return user.nickname || user.name
}
module.exports = { displayName }
