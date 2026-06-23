export const WEB_ALLOWED_ORIGINS_SETTING = 'webAllowedOrigins'
export const WEB_ALLOW_USER_APPROVAL_SETTING = 'webAllowUserApproval'

export const DEFAULT_WEB_ALLOWED_ORIGINS = [
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'https://127.0.0.1:*',
  'http://[::1]:*',
  'https://[::1]:*',
  'https://duckduckgo.com',
  'https://*.duckduckgo.com',
] as const
