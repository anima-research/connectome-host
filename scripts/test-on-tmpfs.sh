#!/usr/bin/env bash
set -eo pipefail

shm_unfit() {
  fs="$(stat -f -c %T /dev/shm 2>/dev/null)" || { echo "stat could not read /dev/shm"; return; }
  [ "$fs" = tmpfs ] || { echo "/dev/shm is $fs, not tmpfs"; return; }
  opts="$(findmnt -no OPTIONS --target /dev/shm 2>/dev/null)" && [ -n "$opts" ] || { echo "findmnt could not read the mount options of /dev/shm"; return; }
  case ",$opts," in *,noexec,*) echo "/dev/shm is mounted noexec"; return ;; esac
  free="$(df -B1 --output=avail /dev/shm 2>/dev/null | tail -1 | tr -d ' ')" || free=
  case "$free" in ''|*[!0-9]*) echo "df could not read the free space of /dev/shm"; return ;; esac
  [ "$free" -ge 1073741824 ] || echo "/dev/shm has under 1 GiB free"
}

why="$(shm_unfit)"
if [ -z "$why" ] && shm="$(mktemp -d /dev/shm/t.XXXXXX)"; then
  export TMPDIR="$shm"
else
  echo "::warning::${why:-mktemp could not make a directory in /dev/shm}, so the suite's temp files stay on the runner's disk"
fi
echo "bun's tmpdir(): $(bun -e 'process.stdout.write(require("node:os").tmpdir())' 2>&1 || echo "bun -e failed")"
df -hT "${TMPDIR:-/tmp}" || true
trap 'df -h "${TMPDIR:-/tmp}" || true' EXIT
npm test
