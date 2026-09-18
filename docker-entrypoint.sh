#!/bin/sh
set -e

# /app/logs may be a bind-mounted host directory (see docker-compose.yml) that shadows whatever
# ownership the image set up at build time - if Docker auto-created it on the host (e.g. it
# didn't exist yet), it's typically owned by root, which the unprivileged "bun" user below
# can't write into. Fix it on every start, then drop from root to "bun" to actually run the app.
mkdir -p /app/logs
chown -R bun:bun /app/logs

exec su-exec bun "$@"
