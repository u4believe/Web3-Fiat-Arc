-- Arc Fintech — full schema
-- Paste this into Supabase → SQL Editor → Run

CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY,
  "email" text NOT NULL UNIQUE,
  "email_hash" text UNIQUE,
  "password_hash" text NOT NULL,
  "name" text NOT NULL,
  "wallet_address" text,
  "circle_wallet_id" text,
  "circle_wallet_address" text,
  "claimed_balance" decimal(20,6) NOT NULL DEFAULT '0',
  "transaction_password_hash" text,
  "pak_hash" text,
  "pak_prefix" text,
  "pak_suffix" text,
  "pak_created_at" timestamp,
  "pak_copied_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "otp_codes" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "code" varchar(6) NOT NULL,
  "type" varchar(20) NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "escrows" (
  "id" serial PRIMARY KEY,
  "sender_address" text NOT NULL,
  "recipient_email" text NOT NULL,
  "email_hash" text NOT NULL,
  "amount" decimal(20,6) NOT NULL,
  "amount_wei" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "tx_hash" text,
  "claim_tx_hash" text,
  "recipient_user_id" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "claimed_at" timestamp
);

CREATE TABLE IF NOT EXISTS "escrow_balances" (
  "id" serial PRIMARY KEY,
  "email_hash" text NOT NULL UNIQUE,
  "amount" decimal(20,6) NOT NULL DEFAULT '0',
  "last_updated" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deposits" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "amount" decimal(20,6) NOT NULL,
  "type" text NOT NULL,
  "source" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_transfer',
  "deposit_reference" text,
  "circle_payment_id" text,
  "tx_hash" text,
  "credited_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "withdrawals" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "amount" decimal(20,6) NOT NULL,
  "type" text NOT NULL,
  "destination" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "tx_hash" text,
  "circle_transfer_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp
);

CREATE TABLE IF NOT EXISTS "virtual_accounts" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "provider" text NOT NULL,
  "account_number" text NOT NULL,
  "account_name" text NOT NULL,
  "bank_name" text NOT NULL,
  "bank_code" text,
  "provider_ref" text,
  "currency" text NOT NULL DEFAULT 'NGN',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "chain_transactions" (
  "id" serial PRIMARY KEY,
  "type" text NOT NULL,
  "tx_hash" text NOT NULL UNIQUE,
  "email_hash" text NOT NULL,
  "amount" decimal(20,6) NOT NULL,
  "sender_address" text,
  "recipient_address" text,
  "block_number" bigint,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "claim_nonces" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "nonce" varchar(66) NOT NULL UNIQUE,
  "email_hash" varchar(66) NOT NULL,
  "wallet_address" varchar(42) NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "indexer_state" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "last_processed_block" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "recurring_transfers" (
  "id" serial PRIMARY KEY,
  "sender_user_id" integer NOT NULL,
  "sender_email" text NOT NULL,
  "recipient_email" text NOT NULL,
  "amount" decimal(20,6) NOT NULL,
  "interval" text NOT NULL,
  "next_run_at" timestamp NOT NULL,
  "end_date" timestamp,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp NOT NULL DEFAULT now()
);
