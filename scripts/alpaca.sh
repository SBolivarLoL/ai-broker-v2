#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Let Bun parse dotenv syntax. Shell sourcing would treat values such as the
# example SEC_USER_AGENT as commands and can also execute arbitrary shell text.
if [ -f .env ]; then
  exec bun --env-file=.env "$script_dir/alpaca.ts" "$@"
fi
exec bun "$script_dir/alpaca.ts" "$@"
