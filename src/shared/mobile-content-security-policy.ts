/** Mobile fonts and branding are bundled as data URLs; executable code stays same-origin. */
export const MOBILE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src data:; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
