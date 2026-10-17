import { PRODUCT_ANNOUNCEMENTS, type ProductAnnouncement } from './product-announcements.ts'

let active: readonly ProductAnnouncement[] = PRODUCT_ANNOUNCEMENTS

/** The catalog the app presents on boot: the shipped one unless a host replaced it. */
export function announcementCatalog(): readonly ProductAnnouncement[] {
  return active
}

/**
 * Replace the boot catalog before the app starts. The browser demo hosts many
 * fixture "existing users" with no history, so it presents none of its own
 * accord and mounts the entries a scenario is about itself.
 */
export function useAnnouncementCatalog(entries: readonly ProductAnnouncement[]): void {
  active = entries
}
