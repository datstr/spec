#!/bin/bash
# The three node runs, one after another: full sync at the default db cache, full sync with a large one, and the snapshot.
cd "$(dirname "$0")"
./ibd.sh full-default full
./ibd.sh full-dbcache8000 full -dbcache=8000
./ibd.sh snapshot-default snapshot
