#!/bin/sh
set -eu

# The model payloads can be very large and are already immutable once a
# download completes. Migrate only the paths the non-root fetcher must mutate:
# directories, its private state, and resumable partial downloads. `find` does
# not follow symlinks and `-xdev` keeps the walk inside the mounted volume.
find /models -xdev -type d -exec chown 10001:10001 {} +
find /models -xdev -type f \( -path '/models/.interloom/*' -o -name '*.part' \) \
  -exec chown 10001:10001 {} +
