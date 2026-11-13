#!/bin/bash
script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec /bin/bash "${script_dir}/Start-Fenster-Test.command" --fps 30 "$@"
