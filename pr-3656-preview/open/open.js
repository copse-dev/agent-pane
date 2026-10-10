function updateThreadLink() {
  const match = /^#thread=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
    location.hash,
  )
  const button = document.getElementById('open-thread')
  const status = document.getElementById('status')
  button.hidden = !match
  if (match) {
    button.href = `copse://thread/${match[1]}`
    status.textContent = 'Open the local thread that created this commit or pull request.'
  } else {
    button.removeAttribute('href')
    status.textContent =
      'This link is missing a valid thread ID. Check that you copied the whole link from the commit or pull request.'
  }
}
window.addEventListener('hashchange', updateThreadLink)
updateThreadLink()
