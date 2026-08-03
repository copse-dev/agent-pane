;(function marketingSite() {
  var image = document.getElementById('feature-tour-image')
  var caption = document.getElementById('feature-tour-caption')
  var triggers = Array.from(document.querySelectorAll('.feature-trigger'))

  if (!image || !caption || triggers.length === 0) return

  triggers.forEach(function wireFeature(trigger) {
    trigger.addEventListener('click', function selectFeature() {
      var nextImage = trigger.getAttribute('data-image')
      var nextAlt = trigger.getAttribute('data-alt')
      var nextCaption = trigger.getAttribute('data-caption')
      if (!nextImage || !nextAlt || !nextCaption) return

      triggers.forEach(function collapseFeature(candidate) {
        var item = candidate.closest('.feature-list-item')
        var active = candidate === trigger
        candidate.setAttribute('aria-expanded', active ? 'true' : 'false')
        if (item) item.classList.toggle('is-expanded', active)
      })

      image.src = nextImage
      image.alt = nextAlt
      image.classList.toggle('is-detail', trigger.getAttribute('data-detail') === 'true')
      caption.textContent = nextCaption
    })
  })
})()
