# Sourced by portable installers. Downloaded bytes must match the pinned SHA-256.
download() {
  local url="$1" destination="$2" checksum="$3" actual
  if [ -f "$destination" ]; then
    actual="$(/usr/bin/openssl dgst -sha256 -r "$destination" | /usr/bin/cut -d ' ' -f 1)"
    if [ "$actual" = "$checksum" ]; then return; fi
  fi
  if [ "${COPSE_PORTABLE_OFFLINE:-0}" = 1 ]; then
    echo "Offline setup needs a valid cached download: $destination. Run this installer online first." >&2
    return 1
  fi
  local curl_args=(--fail --location --retry 3 --proto '=https' --tlsv1.2 "$url" -o "$destination.part")
  if [[ "$url" = https://huggingface.co/* ]] && [ -n "${HF_TOKEN:-}" ]; then
    case "$HF_TOKEN" in *$'\n'*|*$'\r'*) echo 'HF_TOKEN contains a line break.' >&2; return 1 ;; esac
    # Keep the token out of command arguments and files. Curl drops Authorization
    # on cross-origin redirects; never enable --location-trusted here.
    printf 'Authorization: Bearer %s\n' "$HF_TOKEN" | /usr/bin/curl --header @- "${curl_args[@]}"
  else
    /usr/bin/curl "${curl_args[@]}"
  fi
  actual="$(/usr/bin/openssl dgst -sha256 -r "$destination.part" | /usr/bin/cut -d ' ' -f 1)"
  if [ "$actual" != "$checksum" ]; then
    echo "Checksum mismatch: $url" >&2
    return 1
  fi
  mv "$destination.part" "$destination"
}
