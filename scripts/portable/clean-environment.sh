#!/bin/bash
# Keep only terminal/locale identity and the requested offline mode. In particular,
# do not pass through API keys, provider URLs, proxy credentials or runtime hooks.
set -euo pipefail
portable_environment=('PATH=/usr/bin:/bin:/usr/sbin:/sbin' 'SHELL=/bin/bash')
while IFS= read -r name; do
  case "$name" in
    HOME|USER|LOGNAME|TERM|COLORTERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|LANG|LANGUAGE|TZ|\
    LC_ALL|LC_COLLATE|LC_CTYPE|LC_MESSAGES|LC_MONETARY|LC_NUMERIC|LC_TIME|\
    LC_PAPER|LC_NAME|LC_ADDRESS|LC_TELEPHONE|LC_MEASUREMENT|LC_IDENTIFICATION|\
    COPSE_PORTABLE_OFFLINE)
      portable_environment+=("$name=${!name}")
      ;;
  esac
done < <(compgen -e)
exec /usr/bin/env -i "${portable_environment[@]}" "$@"
