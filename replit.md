# USDC Send — Web3 + Web2 Hybrid Application

## Overview

A full-stack hybrid application that lets users send USDC stablecoin to anyone via email, using a smart contract escrow system. Recipients can sign up and claim their funds, then withdraw as USDC or USD via the Circle API.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)
- **Frontend**: React + Vite + Tailwind CSS
- **Web3**: ethers.js v6
- **Payments**: Circle API (sandbox)
- **Auth**: JWT (jsonwebtoken + bcrypt)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server
│   └── usdc-send/          # React + Vite frontend
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
```

## Features

1. **Send USDC via Email** — Connect MetaMask, enter recipient email + amount. Backend returns keccak256 email hash for on-chain escrow.
2. **Smart Contract Escrow** — Funds locked in escrow contract (`0xae4c7eb1d8d01cbe25799c8f3cae84d03aada5cd`) using hashed emails.
3. **Recipient Claim Flow** — Recipients register with email, backend verifies hash, releases escrow to their balance.
4. **Dual Withdrawal**:
   - Crypto: USDC transferred to wallet address via on-chain tx
   - Fiat: Circle API wire transfer to bank account

## Environment Variables

- `RPC_URL` — Testnet RPC endpoint (ARC Network testnet)
- `ESCROW_CONTRACT_ADDRESS` — Deployed escrow contract address
- `BACKEND_SIGNER_PRIVATE_KEY` — Private key for backend-initiated claims
- `CIRCLE_API_KEY` — Circle sandbox API key
- `CIRCLE_API_BASE_URL` — Circle API base URL
- `BACKEND_TRUSTED_SIGNER` — Trusted signer address
- `USDC_ADDRESS` — USDC token contract address

## Database Schema

- `users` — Email, password hash, name, wallet address, claimed USDC balance
- `escrows` — Sender address, recipient email + hash, amount, status, tx hashes
- `withdrawals` — Withdrawal records (crypto/fiat) with status tracking

## API Routes

- `POST /api/auth/register` — Register new user
- `POST /api/auth/login` — Login user
- `GET /api/auth/me` — Get current user (JWT required)
- `POST /api/escrow/send` — Prepare escrow transaction (returns emailHash + contract info)
- `POST /api/escrow/send/confirm` — Confirm escrow tx after frontend sends it
- `GET /api/escrow/pending` — Get pending escrows for current user
- `POST /api/escrow/claim` — Claim pending escrows
- `GET /api/escrow/history` — Transaction history
- `GET /api/escrow/balance` — User balance (claimed + pending)
- `POST /api/withdraw/crypto` — Withdraw USDC to wallet
- `POST /api/withdraw/fiat` — Withdraw USD via Circle

## Frontend Pages

- `/` — Landing page with hero + Send Payment form
- `/login` — Login page
- `/register` — Registration page
- `/dashboard` — Protected: balance, pending claims, withdrawal options, history

## TypeScript & Composite Projects

- Every `lib/*` package extends `tsconfig.base.json` with `composite: true`
- Always typecheck from root: `pnpm run typecheck`
- Run codegen: `pnpm --filter @workspace/api-spec run codegen`
- Push DB schema: `pnpm --filter @workspace/db run push`
