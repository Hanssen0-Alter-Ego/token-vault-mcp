#!/bin/sh
# User-operated uploader. Agents must not run this against the live vault.
set +x
set -eu
umask 077
unset vault_master vault_value

vault_usage='Usage: sh cli/vault-upload.sh --origin https://YOUR_VAULT_HOST NAME ENV_VAR [--overwrite]'
if [ "$#" -eq 1 ] && [ "$1" = --help ]; then printf '%s\n' "$vault_usage"; exit 0; fi
if [ "$#" -lt 4 ] || [ "$#" -gt 5 ] || [ "$1" != --origin ]; then
  printf '%s\n' "$vault_usage" >&2
  exit 2
fi
vault_origin=$2
shift 2
for vault_tool in curl awk stty mktemp rm; do
  command -v "$vault_tool" >/dev/null 2>&1 || { printf '%s\n' 'Requires curl, awk, stty, mktemp and rm.' >&2; exit 2; }
done
printf '%s\n' "$vault_origin" | LC_ALL=C awk '
  NR!=1 {exit 1}
  !/^https:\/\/([a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\])(:[0-9]+)?$/ {exit 1}
  length($0)>300 {exit 1}
  END {if(NR!=1)exit 1}
' || { printf '%s\n' 'Use an HTTPS origin without a path, query, fragment or trailing slash.' >&2; exit 2; }
vault_name=$1 vault_env=$2 vault_overwrite=false
if [ "$#" -eq 3 ]; then
  [ "$3" = --overwrite ] || { printf '%s\n' 'Use --overwrite to replace an existing token.' >&2; exit 2; }
  vault_overwrite=true
fi
case "$vault_name" in ''|[!a-z]*|*[!a-z0-9_/-]*|*//*|*/) printf '%s\n' 'Invalid credential name.' >&2; exit 2;; esac
case "$vault_env" in ''|[!A-Z]*|*[!A-Z0-9_]*) printf '%s\n' 'Invalid environment variable name.' >&2; exit 2;; esac
[ "${#vault_name}" -le 64 ] && [ "${#vault_env}" -le 64 ] || exit 2

vault_dir=$(mktemp -d)
vault_tty=''
vault_cleanup() {
  if [ -n "$vault_tty" ]; then stty "$vault_tty" </dev/tty 2>/dev/null || :; fi
  rm -rf "$vault_dir"
}
trap vault_cleanup 0
trap 'exit 130' 2
trap 'exit 143' 1 15
vault_tty=$(stty -g </dev/tty)
vault_read_hidden() {
  stty -echo </dev/tty
  printf '%s' "$2" >/dev/tty
  IFS= read -r "$1" </dev/tty
  stty "$vault_tty" </dev/tty
  printf '\n' >/dev/tty
}
vault_read_hidden vault_master 'MCP_ACCESS_KEY (hidden): '
case "$vault_master" in ''|*[!0-9a-f]*) printf '%s\n' 'MCP_ACCESS_KEY must be 64 lowercase hexadecimal characters.' >&2; exit 2;; esac
[ "${#vault_master}" -eq 64 ] || { printf '%s\n' 'MCP_ACCESS_KEY must be 64 characters.' >&2; exit 2; }
vault_read_hidden vault_value 'Service Token, one line (hidden): '
[ -n "$vault_value" ] && [ "${#vault_value}" -le 8192 ] || { printf '%s\n' 'Token is empty or too long.' >&2; exit 2; }
printf 'Authorization: Bearer %s\n' "$vault_master" >"$vault_dir/headers"
unset vault_master
printf '{"name":"%s","envVar":"%s","overwrite":%s,"token":' "$vault_name" "$vault_env" "$vault_overwrite" >"$vault_dir/body.json"
printf '%s' "$vault_value" | LC_ALL=C awk '
  BEGIN {printf "\"";for(i=1;i<32;i++)escape[sprintf("%c",i)]=sprintf("\\u%04x",i)}
  {for(i=1;i<=length($0);i++){c=substr($0,i,1);if(c=="\\")printf "%s","\\\\";else if(c=="\"")printf "%s","\\\"";else if(c in escape)printf "%s",escape[c];else printf "%s",c}}
  END {printf "\""}
' >>"$vault_dir/body.json"
printf '}' >>"$vault_dir/body.json"
unset vault_value
curl -q --silent --show-error --fail --proto '=https' \
  --request POST --connect-timeout 10 --max-time 20 --max-redirs 0 \
  --header "@$vault_dir/headers" --header 'Content-Type: application/json' \
  --data-binary "@$vault_dir/body.json" \
  "$vault_origin/admin/tokens"
printf '\n'
