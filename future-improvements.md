# Future improvements

These are deliberately deferred because the measured benefit is small for one paper account.

- Add a 5–15 second shared cache for portfolio risk and performance only if polling frequency or user count grows. Current warm concurrent dashboard loads complete in about 0.21–0.23 seconds.
- Virtualize the option-chain table if the UI cap grows beyond 120 rendered contracts.
- Add indexed receipt/order columns before supporting multiple accounts; the current JSON scan is trivial at today’s volume.
- Move the server and single-page UI into smaller modules only when independent deployment or ownership boundaries appear.
- Add sector/factor classifications only with a licensed, timestamped source; Alpaca asset metadata does not supply them for this account.
