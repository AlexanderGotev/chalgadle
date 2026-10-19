#!/usr/bin/env bash
set -euo pipefail
SRC="/home/ubuntu/poznai-pesenta/data/library.db"
DIR="/home/ubuntu/backups"
mkdir -p "$DIR"
sqlite3 "$SRC" ".backup '$DIR/library-$(date +%F).db'"
ls -1t "$DIR"/library-*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
