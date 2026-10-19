#!/bin/sh
# POSIX sh helper. Extra runtime dependencies: curl and openssl (no Node/Python/jq).
# Never source this file. Run: sh vault-cli.sh prepare|run|store ...
set +x
set -eu
umask 077
# Do not inherit the export attribute for variables that will hold secrets.
unset vault_mode vault_origin vault_env vault_state vault_work vault_verifier vault_token vault_claim vault_link vault_cleanup_state
vault_work='' vault_cleanup_state=0 vault_state=''
vault_die() { printf '%s\n' "$1" >&2; exit 1; }
vault_cleanup() {
  if [ "$vault_cleanup_state" = 1 ]; then
    rm -f "$vault_state" 2>/dev/null || return 1
    vault_cleanup_state=0
  fi
  if [ -n "$vault_work" ]; then
    rm -rf "$vault_work" 2>/dev/null || return 1
    vault_work=''
  fi
}
trap 'vault_cleanup' 0
trap 'exit 1' 1 2 3 15
vault_usage='Usage: sh vault-cli.sh prepare|run|store --origin https://vault.example --env GH_TOKEN --state /private/claim.state [-- command args]'
[ "$#" -gt 0 ] || vault_die "$vault_usage"
vault_mode=$1; shift
case "$vault_mode" in prepare|run|store) ;; *) vault_die "$vault_usage" ;; esac
vault_origin='' vault_env=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --origin|--env|--state)
      [ "$#" -ge 2 ] || vault_die "$vault_usage"
      case "$1" in
        --origin) [ -z "$vault_origin" ] || vault_die "$vault_usage"; vault_origin=$2 ;;
        --env) [ -z "$vault_env" ] || vault_die "$vault_usage"; vault_env=$2 ;;
        --state) [ -z "$vault_state" ] || vault_die "$vault_usage"; vault_state=$2 ;;
      esac
      shift 2 ;;
    *) vault_die "$vault_usage" ;;
  esac
done
for vault_tool in curl openssl awk tr wc cmp stat id date dirname mktemp cat rm; do
  command -v "$vault_tool" >/dev/null 2>&1 || vault_die 'Missing dependency: curl, openssl or standard system utilities.'
done
printf '%s\n' "$vault_origin" | LC_ALL=C awk '
  NR!=1 {exit 1}
  !/^https:\/\/([a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\])(:[0-9]+)?$/ {exit 1}
  length($0)>300 {exit 1}
  END {if(NR!=1)exit 1}
' || vault_die 'Use an HTTPS origin only, without a path, query, fragment or trailing slash.'
case "$vault_env" in ''|[!A-Z]*|*[!A-Z0-9_]*|PATH|HOME|SHELL|ENV|BASH_ENV|IFS|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|LD_*|DYLD_*) vault_die 'Invalid credential environment variable.' ;; esac
[ "${#vault_env}" -le 64 ] || vault_die 'Invalid credential environment variable.'
case "$vault_state" in /*) ;; *) vault_die 'Use an absolute state path inside a private directory.' ;; esac
if [ "$vault_mode" = run ]; then [ "$#" -gt 0 ] || vault_die 'A child command is required.'
else [ "$#" = 0 ] || vault_die "$vault_usage"; fi

# GNU/Linux and macOS stat have different flags. Read metadata only, never source state.
vault_metadata() {
  stat -c '%a:%u:%s' "$1" 2>/dev/null || stat -f '%Lp:%u:%z' "$1" 2>/dev/null
}
vault_parent=$(dirname "$vault_state")
[ -d "$vault_parent" ] && [ ! -L "$vault_parent" ] || vault_die 'State directory must be a private real directory.'
vault_parent_info=$(vault_metadata "$vault_parent") || vault_die 'Cannot check state directory permissions.'
vault_uid=$(id -u)
case "$vault_parent_info" in "700:$vault_uid:"*) ;; *) vault_die 'State directory must be owned by you with mode 0700. Use mktemp -d.' ;; esac
vault_work=$(mktemp -d "${TMPDIR:-/tmp}/token-vault.XXXXXXXX") || vault_die 'Cannot create private temporary directory.'
vault_now=$(date +%s)
case "$vault_now" in ''|*[!0-9]*) vault_die 'Cannot read the current time.' ;; esac

if [ "$vault_mode" = prepare ]; then
  [ ! -e "$vault_state" ] && [ ! -L "$vault_state" ] || vault_die 'State already exists; choose a fresh path.'
  openssl rand -out "$vault_work/random" 32 2>/dev/null || vault_die 'Random secret generation failed.'
  openssl base64 -A -in "$vault_work/random" -out "$vault_work/base64" 2>/dev/null || vault_die 'Random secret encoding failed.'
  vault_verifier=$(tr '+/' '-_' < "$vault_work/base64" | tr -d '=\n')
  case "$vault_verifier" in *[!A-Za-z0-9_-]*) vault_die 'Random secret generation failed.' ;; esac
  [ "${#vault_verifier}" = 43 ] || vault_die 'Random secret generation failed.'
  printf '%s' "$vault_verifier" | openssl dgst -sha256 -binary > "$vault_work/digest" 2>/dev/null || vault_die 'SHA-256 failed.'
  openssl base64 -A -in "$vault_work/digest" -out "$vault_work/encoded" 2>/dev/null || vault_die 'SHA-256 encoding failed.'
  vault_challenge=$(tr '+/' '-_' < "$vault_work/encoded" | tr -d '=\n')
  [ "${#vault_challenge}" = 43 ] || vault_die 'SHA-256 encoding failed.'
  # Separate, non-executable format from Node state; includes origin/env/age binding.
  (set -C; printf '%s\n' 'token-vault-sh-v1' "$vault_origin" "$vault_env" "$vault_now" "$vault_verifier" > "$vault_state") 2>/dev/null || vault_die 'Cannot create new private state.'
  printf '{"claimChallenge":"%s","method":"S256"}\n' "$vault_challenge"
  exit 0
fi

vault_link=$(cat)
vault_kind=write
[ "$vault_mode" != run ] || vault_kind=read
vault_endpoint="$vault_origin/redeem/$vault_kind"
vault_claim=${vault_link##*#}
case "$vault_claim" in *[!a-f0-9]*) vault_die 'Link does not match the configured vault and operation.' ;; esac
[ "${#vault_claim}" = 64 ] && [ "$vault_link" = "$vault_endpoint#$vault_claim" ] || vault_die 'Link does not match the configured vault and operation.'
[ -f "$vault_state" ] && [ ! -L "$vault_state" ] || vault_die 'Missing or unsafe state. Run prepare again.'
vault_info=$(vault_metadata "$vault_state") || vault_die 'Cannot check state permissions.'
case "$vault_info" in "600:$vault_uid:"*) ;; *) vault_die 'State must be owned by you with mode 0600.' ;; esac
vault_size=${vault_info##*:}
[ "$vault_size" -le 1024 ] || vault_die 'Invalid state.'
exec 3< "$vault_state"
IFS= read -r vault_version <&3 && IFS= read -r vault_saved_origin <&3 && IFS= read -r vault_saved_env <&3 && IFS= read -r vault_created <&3 && IFS= read -r vault_verifier <&3 || vault_die 'Invalid state. Run prepare again.'
if IFS= read -r vault_extra <&3; then vault_die 'Invalid state. Run prepare again.'; fi
exec 3<&-
[ "$vault_version" = token-vault-sh-v1 ] && [ "$vault_saved_origin" = "$vault_origin" ] && [ "$vault_saved_env" = "$vault_env" ] || vault_die 'Mismatched state. Run prepare again.'
case "$vault_created" in ''|*[!0-9]*) vault_die 'Invalid state time.' ;; esac
[ "${#vault_created}" -le 11 ] || vault_die 'Invalid state time.'
[ "$vault_created" -ge "$((vault_now - 300))" ] && [ "$vault_created" -le "$((vault_now + 5))" ] || vault_die 'Expired state. Run prepare again.'
case "$vault_verifier" in *[!A-Za-z0-9_-]*) vault_die 'Invalid state secret.' ;; esac
[ "${#vault_verifier}" = 43 ] || vault_die 'Invalid state secret.'
vault_cleanup_state=1
printf 'Authorization: Bearer %s\nX-Vault-Verifier: %s\n' "$vault_claim" "$vault_verifier" > "$vault_work/request.headers"

vault_valid_token_file() {
  vault_bytes=$(wc -c < "$1" | tr -d '[:space:]')
  [ "$vault_bytes" -gt 0 ] && [ "$vault_bytes" -le 8192 ] || return 1
  LC_ALL=C tr -d '\000\012\015' < "$1" > "$vault_work/checked"
  cmp -s "$1" "$vault_work/checked"
}
if [ "$vault_mode" = store ]; then
  # Only the variable name enters eval; its strict allowlist above prevents code injection.
  # The provider value is expanded once inside a quoted assignment, never evaluated as code.
  eval 'vault_token="${'"$vault_env"'-}"'
  printf '%s' "$vault_token" > "$vault_work/source"
  vault_valid_token_file "$vault_work/source" || vault_die 'Source credential environment variable is missing or invalid.'
  LC_ALL=C awk '
    BEGIN {printf "{\"token\":\"";for(i=1;i<32;i++)escape[sprintf("%c",i)]=sprintf("\\u%04x",i)}
    {for(i=1;i<=length($0);i++){c=substr($0,i,1);if(c=="\\")printf "%s","\\\\";else if(c=="\"")printf "%s","\\\"";else if(c in escape)printf "%s",escape[c];else printf "%s",c}}
    END {printf "\"}"}
  ' "$vault_work/source" > "$vault_work/request.body"
  printf 'Content-Type: application/json\n' >> "$vault_work/request.headers"
fi

vault_request() {
  # -q MUST be first: ignore .curlrc. Secrets enter via private files, never argv.
  curl -q --silent --proto '=https' --request POST --max-time 15 --connect-timeout 10 \
    --max-redirs 0 --max-filesize 8192 --header "@$vault_work/request.headers" \
    --dump-header "$vault_work/response.headers" --output "$vault_work/response" \
    --write-out '%{http_code}' "$@" --url "$vault_endpoint" 2> "$vault_work/curl.error"
}
if [ "$vault_mode" = store ]; then
  vault_status=$(vault_request --data-binary "@$vault_work/request.body") || vault_die 'Vault transport failed. Prepare a fresh state and request a fresh link.'
else
  vault_status=$(vault_request) || vault_die 'Vault transport failed. Prepare a fresh state and request a fresh link.'
fi
case "$vault_status" in 2[0-9][0-9]) ;; *) vault_die "Vault request failed ($vault_status). Prepare a fresh state and request a fresh link." ;; esac
if [ "$vault_mode" = store ]; then exit 0; fi
LC_ALL=C awk -v expected="$vault_env" '
  /^HTTP\// {type="";env="";nt=0;ne=0}
  {sub(/\r$/,"");p=index($0,":");if(p){key=tolower(substr($0,1,p-1));value=substr($0,p+1);sub(/^[ \t]+/,"",value);sub(/[ \t]+$/,"",value);if(key=="content-type"){type=tolower(value);nt++}if(key=="x-vault-env"){env=value;ne++}}}
  END {exit !(nt==1&&index(type,"text/plain")==1&&ne==1&&env==expected)}
' "$vault_work/response.headers" || vault_die 'Unexpected token response or environment name mismatch.'
vault_valid_token_file "$vault_work/response" || vault_die 'Invalid token response.'
vault_token=$(cat "$vault_work/response")
vault_cleanup || vault_die 'Cannot remove private claim files; delete them locally.'
unset vault_verifier vault_claim vault_link
export "$vault_env=$vault_token"
unset vault_token
# All private files are gone before the target process starts. Preserve its exit code.
exec "$@"
