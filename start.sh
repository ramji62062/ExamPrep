#!/usr/bin/env bash
set -euo pipefail

# Render supplies PORT and manages the process lifecycle. Do not probe or
# terminate listeners here; local-only tools such as lsof are not guaranteed.
exec npm start
