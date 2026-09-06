# Agamemnon Telegram Trading Platform

Agamemnon is a Telegram-first trading platform. PostgreSQL is the permanent
financial source of truth; Telegram is only the user interface. All trading
engine calls cross `src/trading-engine/adapter.ts`, and nothing in
`src/trading-engine/` is modified by the platform services.

## Current operating flow

1. `/start` resolves the authenticated Telegram identity and creates the
   internal account, wallet, and notification settings once.
2. The dashboard reads PostgreSQL asset balances and asks the adapter for
   current positions and P&L.
3. Wallet → Deposit lets a user choose SOL on Solana or USDT on BSC, shows
   the configured shared custody address, and asks for a transaction hash.
4. The selected provider performs real JSON-RPC verification of destination,
   asset/token contract, amount, success, and required confirmations.
5. Only a confirmed observation posts an idempotent ledger entry and credits
   the matching network/asset balance.
6. Wallet → Withdraw validates the destination, amount, limits, and available
   asset balance, then creates a `PENDING_REVIEW` request. Approval reserves
   funds in the ledger.
7. Withdrawal signing is an explicit external boundary. Without an injected
   custody signer the request fails safely with:
   `UNTESTED — EXTERNAL INFRASTRUCTURE REQUIRED`.
   The application never receives or stores private keys.
8. Trade strategy starts reserve the USD trading allocation, call the
   `TradingEngineAdapter`, and release funds if the engine rejects the start.
   Stops call the adapter before releasing the allocation.
9. Deposit scanning, stale-deposit reconciliation, notification dispatch, and
   balance reconciliation run in restart-safe scheduled jobs.

## Custody model

The configured deposit destinations are shared:

```text
SOL:  D7TwNPt2FE6um6MxX8wJAo1pPqmwP6EpZFF68D2dkYrE
USDT: 0x66b6c403b307ef563ddb34d75e94a023524035a3 (BEP20 / BSC)
```

Because a shared address cannot identify a user, the watcher persists
unmatched chain observations but never attributes or credits them
automatically. The user must submit the transaction hash, or a future
operator workflow must link the observation to a deposit record.

## Security and durability

- Fixed-point `bigint` helpers are used for balance-affecting arithmetic.
- Ledger entries are append-only and idempotent by source reference.
- Asset balances are keyed by wallet, network, and asset.
- Deposit transaction hashes are unique per network.
- Identity creation uses PostgreSQL advisory locking.
- Telegram sessions and temporary flow state use Redis storage with TTL.
- Callback routes derive the user from authenticated Telegram context, never
  from callback data.
- A rate limiter protects Telegram messages and callback queries.
- Notification delivery is persisted and deduplicated.
- Reconciliation writes auditable runs and issue rows instead of silently
  overwriting balances.

## Telegram visual system

Premium visual assets live in `assets/telegram/` and are sent through the
central helper at `src/bot/media.ts`:

- New users receive the Agamemnon helmet-and-token welcome banner plus a short
  onboarding GIF.
- SOL and USDT deposit screens show a matching token medallion.
- Transaction-hash submission shows a short “verifying on-chain” GIF, which is
  removed after verification.
- Successful strategy starts show the helmet emblem as an execution moment.

BTC is included in the visual token set and welcome artwork, but it is not
financially enabled as a deposit or withdrawal asset.

## Setup

```bash
npm install
cp .env.example .env
npm run db:generate
npm run db:migrate
npm run db:seed
npm run build
npm test
```

Required environment variables:

```text
TELEGRAM_BOT_TOKEN=<from @BotFather>
DATABASE_URL=REPLACE_WITH_DATABASE_URL
REDIS_URL=redis://localhost:6379
```

For live blockchain verification, set `SOLANA_RPC_URL` and/or `BSC_RPC_URL`.
The BSC provider also needs `BSC_USDT_CONTRACT_ADDRESS` to match the
configured token. Missing RPC configuration is fail-closed.

Run the bot with:

```bash
npm run dev
```

The bot uses long polling by default. Set `TELEGRAM_USE_WEBHOOK=true`,
`TELEGRAM_WEBHOOK_URL`, and `TELEGRAM_WEBHOOK_SECRET` for webhook mode.

## Verification

The repository includes PostgreSQL integration tests for identity, callback
authorization, ledger idempotency/reservation, deposit verification,
strategy data, and the adapter-backed engine. Tests require a
migrated database and a test value for `TELEGRAM_BOT_TOKEN`:

```bash
TELEGRAM_BOT_TOKEN=test npm test
```

The adapter's built-in verification engine exercises the platform lifecycle.
It does not turn on-chain deposits into unverified balances and it does not
replace a production custody signer. A production engine can
be installed with `tradingEngineAdapter.setEngine(...)` without changing
Telegram handlers or ledger services.