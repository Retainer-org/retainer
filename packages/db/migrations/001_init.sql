-- Retainer charge engine schema.
--
-- Two invariants this schema exists to enforce:
--   1. A (permission, billing period) pair can be charged at most once.
--      Enforced by UNIQUE (permission_id, period_start) on charges.
--   2. A charge is only ever marked paid after its on-chain events are
--      confirmed -- never on broadcast. Enforced by charges.state and the
--      reconciler, which is the sole writer of state='confirmed'.

BEGIN;

-- ---------------------------------------------------------------- permissions

-- The signed spend permission. This table is also the consent audit trail:
-- the exact struct the user signed, their signature, and when. Nothing here is
-- ever mutated except revocation bookkeeping.
CREATE TABLE permissions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_hash   TEXT        NOT NULL UNIQUE,   -- manager.getHash(permission)

  -- the SpendPermission struct, exactly as signed
  account           TEXT        NOT NULL,
  spender           TEXT        NOT NULL,          -- our SpendRouter
  token             TEXT        NOT NULL,
  allowance         NUMERIC(78,0) NOT NULL,        -- uint160
  period_seconds    BIGINT      NOT NULL,
  start_ts          BIGINT      NOT NULL,
  end_ts            BIGINT      NOT NULL,
  salt              NUMERIC(78,0) NOT NULL,
  extra_data        TEXT        NOT NULL,          -- abi.encode(executor, recipient)

  -- decoded from extra_data, denormalised for querying
  executor          TEXT        NOT NULL,
  recipient         TEXT        NOT NULL,

  chain_id          INTEGER     NOT NULL,
  signature         TEXT        NOT NULL,          -- EIP-712 / ERC-6492 signature
  signed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- on-chain registration (approveWithSignature), submitted by us, gasless for the user
  approved_tx_hash  TEXT,
  approved_at       TIMESTAMPTZ,

  revoked_at        TIMESTAMPTZ,
  revoked_tx_hash   TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX permissions_account_idx ON permissions (account);
CREATE INDEX permissions_active_idx  ON permissions (revoked_at) WHERE revoked_at IS NULL;

-- -------------------------------------------------------------------- charges

-- One row per (permission, billing period). This is the idempotency key.
-- period_start is derived deterministically from the permission's start and
-- period, so it needs no coordination between workers.
CREATE TYPE charge_state AS ENUM (
  'pending',           -- created, not yet attempted
  'in_flight',         -- an attempt is signed and/or broadcast
  'confirmed',         -- on-chain events confirmed. terminal, success.
  'failed_retryable',  -- INSUFFICIENT_BALANCE -- retry with backoff inside the period
  'failed_deferred',   -- ALLOWANCE_EXHAUSTED / NOT_STARTED -- retry at a known future time
  'failed_terminal'    -- REVOKED / EXPIRED -- never retry
);

-- The six failure modes, kept distinct. Collapsing these loses the information
-- the dunning layer will need later, so they are recorded separately from day one.
CREATE TYPE failure_mode AS ENUM (
  'REVOKED',
  'EXPIRED',
  'INSUFFICIENT_BALANCE',
  'ALLOWANCE_EXHAUSTED',
  'NOT_STARTED',
  'NOT_APPROVED',
  'UNKNOWN'            -- decoder fell through; always investigate
);

CREATE TABLE charges (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_id  BIGINT       NOT NULL REFERENCES permissions(id),

  period_start   BIGINT       NOT NULL,   -- unix seconds, derived, not chosen
  period_end     BIGINT       NOT NULL,

  -- amount_requested is computed at charge time (fixed OR metered usage).
  amount         NUMERIC(78,0) NOT NULL,
  amount_source  TEXT         NOT NULL DEFAULT 'fixed',  -- 'fixed' | 'usage'
  usage_note     TEXT,                                   -- how a usage amount was derived

  state          charge_state NOT NULL DEFAULT 'pending',
  last_failure   failure_mode,
  failure_detail TEXT,

  attempts       INTEGER      NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- set by the reconciler ONLY, from confirmed on-chain events
  confirmed_tx_hash TEXT,
  confirmed_at      TIMESTAMPTZ,
  confirmed_amount  NUMERIC(78,0),

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- THE idempotency key. One charge per permission per billing period, forever.
  CONSTRAINT charges_one_per_period UNIQUE (permission_id, period_start)
);

CREATE INDEX charges_claimable_idx ON charges (next_attempt_at)
  WHERE state IN ('pending', 'failed_retryable', 'failed_deferred');
CREATE INDEX charges_inflight_idx  ON charges (id) WHERE state = 'in_flight';

-- ------------------------------------------------------------ charge attempts

-- One row per broadcast attempt. Many attempts may exist per charge; at most
-- one can ever land, because every attempt persists its signed raw transaction
-- and hash BEFORE broadcasting, and recovery re-broadcasts that identical
-- transaction rather than re-signing.
CREATE TYPE attempt_state AS ENUM (
  'signed',          -- raw tx persisted; broadcast not yet confirmed to have happened
  'broadcast',       -- eth_sendRawTransaction returned
  'mined_success',
  'mined_reverted',
  'superseded',      -- nonce consumed by a different transaction
  'abandoned'
);

CREATE TABLE charge_attempts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_id    BIGINT        NOT NULL REFERENCES charges(id),

  nonce        BIGINT        NOT NULL,
  tx_hash      TEXT          NOT NULL,   -- known before broadcast: we sign locally
  raw_tx       TEXT          NOT NULL,   -- re-broadcast verbatim on recovery
  amount       NUMERIC(78,0) NOT NULL,

  state        attempt_state NOT NULL DEFAULT 'signed',

  gas_used     BIGINT,
  effective_gas_price NUMERIC(78,0),
  block_number BIGINT,
  revert_selector TEXT,                  -- 4-byte custom error, when reverted
  failure_mode failure_mode,

  signed_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  broadcast_at TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ,

  CONSTRAINT charge_attempts_tx_hash_uniq UNIQUE (tx_hash)
);

CREATE INDEX charge_attempts_charge_idx ON charge_attempts (charge_id);
CREATE INDEX charge_attempts_open_idx   ON charge_attempts (id)
  WHERE state IN ('signed', 'broadcast');

-- --------------------------------------------------------------- reconciliation

-- Indexed on-chain events. A charge is confirmed only when BOTH the manager's
-- SpendPermissionUsed and the router's SpendRouted are present for its tx.
CREATE TABLE onchain_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_name   TEXT         NOT NULL,    -- 'SpendPermissionUsed' | 'SpendRouted'
  tx_hash      TEXT         NOT NULL,
  log_index    INTEGER      NOT NULL,
  block_number BIGINT       NOT NULL,
  block_time   TIMESTAMPTZ,

  permission_hash TEXT,
  account      TEXT,
  spender      TEXT,
  recipient    TEXT,
  token        TEXT,
  value        NUMERIC(78,0),

  raw          JSONB        NOT NULL,
  indexed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT onchain_events_uniq UNIQUE (tx_hash, log_index)
);

CREATE INDEX onchain_events_perm_idx ON onchain_events (permission_hash);
CREATE INDEX onchain_events_tx_idx   ON onchain_events (tx_hash);

-- Indexer checkpoint, so restarts backfill rather than skip.
CREATE TABLE indexer_state (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  last_indexed_block  BIGINT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT indexer_state_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------- audit trail

-- Append-only. Every permission signature, charge attempt, confirmation and
-- revocation, with timestamps, exportable. Cheap now, expensive to retrofit,
-- and likely to matter for consumer-authorization rules.
CREATE TABLE audit_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor         TEXT        NOT NULL,   -- 'user' | 'executor' | 'reconciler' | 'system'
  event         TEXT        NOT NULL,
  permission_id BIGINT      REFERENCES permissions(id),
  charge_id     BIGINT      REFERENCES charges(id),
  tx_hash       TEXT,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_permission_idx ON audit_log (permission_id, occurred_at);
CREATE INDEX audit_log_time_idx       ON audit_log (occurred_at);

-- ------------------------------------------------------------ nonce ledger

-- Nonce allocation for the executor EOA. Allocated under pg_advisory_xact_lock
-- so all sends are strictly sequential and no two attempts share a nonce.
CREATE TABLE executor_nonces (
  executor     TEXT   PRIMARY KEY,
  next_nonce   BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
