#!/bin/bash
script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf 'Das iPhone-Projekt bitte mit Xcode auf dem Mac öffnen.\n'
  exit 1
fi
/usr/bin/open "${script_dir}/WaveCompanion.xcodeproj"
