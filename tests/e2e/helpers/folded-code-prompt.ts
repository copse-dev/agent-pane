export const FOLDED_CODE_PAYLOAD = [
  '{',
  '  "service": "release-notifier",',
  '  "intervalSeconds": 15,',
  '  "timeoutSeconds": 30,',
  '  "retryLimit": 3,',
  '  "region": "eu-west",',
  '  "notifications": {',
  '    "email": true,',
  '    "desktop": true,',
  '    "sound": false',
  '  },',
  '  "logging": "info"',
  '}',
].join('\n')

export const FOLDED_CODE_PROMPT = `Review this configuration before I change the timeout:\n\n\`\`\`json\n${FOLDED_CODE_PAYLOAD}\n\`\`\``
