# Agamemnon Telegram Trading Bot

Agamemnon is a Telegram-first trading platform with PostgreSQL as its financial
source of truth, Redis-backed session state, and fail-closed blockchain deposit
verification.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the bot and health server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server run db:migrate` — apply development migrations
- `pnpm --filter @workspace/api-server run db:seed` — seed the strategy catalog
- Health: `/api/healthz`; readiness: `/api/readyz`
- Required runtime configuration: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and
  either a native Redis URL or the Upstash REST URL/token pair

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Fastify 4
- DB: PostgreSQL + Drizzle ORM
- Bot: grammY with long polling by default
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/index.ts` — startup lifecycle, health routes, jobs,
  Telegram transport, and graceful shutdown
- `artifacts/api-server/src/config/env.ts` — validated runtime configuration
- `artifacts/api-server/src/db/schema/` — PostgreSQL schema source
- `artifacts/api-server/drizzle/` — checked-in development migrations
- `artifacts/api-server/src/blockchain/providers/` — Solana and BSC verification
- `artifacts/api-server/src/trading-engine/` — isolated trading engine boundary

## Architecture decisions

- PostgreSQL is the permanent financial source of truth; Telegram is only the
  user interface.
- Ledger writes are append-only and idempotent, with fixed-point bigint
  arithmetic for balance-affecting values.
- Redis stores Telegram session state and the runtime lease; the bot refuses to
  start without reachable Redis and PostgreSQL.
- Blockchain providers fail closed when RPC configuration is absent or a
  transaction cannot be verified.
- Withdrawal broadcasting remains an explicit external custody boundary; no
  private keys are stored by this application.

## Product

The bot supports onboarding, wallet balances, SOL and BSC USDT deposits,
transaction verification, withdrawal review flows, strategy discovery and
execution, positions, history, settings, notifications, and reconciliation
jobs.

## User preferences

- Keep credentials in Replit Secrets and never place provider keys in source
  files or chat.

## Gotchas

- This is a long-running Telegram bot, so production deployment must use the
  VM target rather than autoscale.
- The shared custody addresses in `src/config/deposit-addresses.ts` cannot
  identify a user by themselves; unmatched chain observations are never
  auto-credited.
- Production database schema changes are applied through the Publish flow.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
