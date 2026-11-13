#!/bin/bash
# Separate local window-capture development test.

pause_if_terminal() {
  if [[ -t 0 && -t 1 ]]; then
    printf '\nEnter zum Schließen … '
    IFS= read -r launcher_reply
  fi
}

script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$script_dir" ]] || ! cd -- "$script_dir"; then
  printf 'Bitte die ZIP-Datei vollständig entpacken.\n'
  pause_if_terminal
  exit 1
fi

node_binary=''
node_from_path="$(command -v node 2>/dev/null)"
for node_candidate in "$node_from_path" /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -n "$node_candidate" && -x "$node_candidate" ]] || continue
  node_major="$("$node_candidate" -p 'Number.parseInt(process.versions.node.split(".")[0], 10)' 2>/dev/null)"
  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 22 )); then
    node_binary="$node_candidate"
    break
  fi
done

if [[ -z "$node_binary" ]]; then
  printf 'Für den Fenster-Test wird Node.js 22 oder neuer benötigt.\n'
  pause_if_terminal
  exit 1
fi

"$node_binary" src/app.mjs "$@"
run_status=$?
pause_if_terminal
exit "$run_status"
