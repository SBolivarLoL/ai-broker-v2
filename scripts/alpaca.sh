#!/bin/sh
set -eu

if [ -f .env ]; then set -a; . ./.env; set +a; fi

: "${APCA_API_KEY_ID:?APCA_API_KEY_ID is required}"
: "${APCA_API_SECRET_KEY:?APCA_API_SECRET_KEY is required}"
command -v alpaca >/dev/null || { echo "Install alpacahq/tap/cli" >&2; exit 1; }

export ALPACA_API_KEY="$APCA_API_KEY_ID"
export ALPACA_SECRET_KEY="$APCA_API_SECRET_KEY"
export ALPACA_LIVE_TRADE=false
export ALPACA_QUIET=1
exec alpaca "$@"
