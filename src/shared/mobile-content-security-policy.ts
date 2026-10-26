/**
 * Mobile fonts and branding are bundled as data URLs; executable code stays
 * same-origin. `frame-src 'self'` admits only the sandboxed Mermaid frame
 * document (`/mermaid-frame.html`), the one framed route the server has.
 */
export const MOBILE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src data:; img-src data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
