# Features and rationale

This is the central explainability file required by the challenge brief.

- **Connected account:** the dashboard shows live paper equity, buying power, and positions.
- **Market view:** stock search retrieves the latest available Alpaca price.
- **Order ticket:** buy and sell controls show a confirmation before submitting a paper market order.
- **Order lifecycle:** accepted orders appear immediately as pending, then the dashboard polls until Alpaca fills them and they become positions. This avoids pretending a queued order is already owned when markets are closed.
- **Consumer-first UI:** a responsive, card-based dashboard uses friendly language and high-energy color inspired by bunq's simple, mobile money management.
- **AI Portfolio Copilot:** OpenAI analyzes current Alpaca paper holdings into three structured ideas, each with an action, thesis, risk, invalidation condition, and confidence. It cannot place orders; users retain control through the existing confirmation flow.
- **Paper-only safety:** the client hard-codes paper trading so a configuration mistake cannot send a live order.

AI trade ideas, portfolio intelligence, an agent, and a UI are deferred until this trading path works with team credentials.
