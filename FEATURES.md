# Features and rationale

This is the central explainability file required by the challenge brief.

- **Connected account:** `account` proves the Alpaca paper account is live.
- **Market view:** `quote SYMBOL` retrieves the latest available Alpaca price.
- **Order ticket:** `buy` and `sell` submit market orders only after explicit `--confirm`.
- **Paper-only safety:** the client hard-codes paper trading so a configuration mistake cannot send a live order.

AI trade ideas, portfolio intelligence, an agent, and a UI are deferred until this trading path works with team credentials.
