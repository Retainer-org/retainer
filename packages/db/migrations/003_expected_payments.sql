-- Phase 2: expected payments as the top-level obligation.
--
-- An expected payment is satisfied one of two ways, both first-class:
--   pull  -- the existing charge engine draws on a spend permission
--   watch -- an incoming transfer is detected and matched
--
-- Charges stop being the top-level object and become one fulfilment method.
-- The immediate win: a terminally failed charge leaves its expected payment
-- overdue, which fires the same alert as a watch payment that never arrived.
-- One overdue path, not two.
--
-- Watch mode exists because a Safe multisig can never be the account of a
-- spend permission: SpendPermissionManager._execute hard-casts the payer to
-- CoinbaseSmartWallet and calls execute(target,value,data), which a Safe does
-- not expose. DAOs and treasuries paying from multisigs are reachable only
-- this way.

BEGIN;

-- ------------------------------------------------------------- customers
-- Deliberately minimal: only what matching needs to attribute a transfer.

CREATE TABLE customers (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Known sender addresses. The UNIQUE on (chain_id, address) is load-bearing:
-- an address belongs to at most one customer, which is what makes the
-- "sender known" signal unambiguous rather than a ranking problem.
CREATE TABLE customer_addresses (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT      NOT NULL REFERENCES customers(id),
  chain_id    INTEGER     NOT NULL,
  address     TEXT        NOT NULL,
  note        TEXT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_addresses_uniq UNIQUE (chain_id, address)
);

-- ------------------------------------------------------ watched addresses
-- Receiving addresses the merchant registers. A table, not env config: if the
-- receiving address is configuration, the product is single-tenant and
-- "the merchant registers a receiving address" is not true.

CREATE TABLE watched_addresses (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id   INTEGER     NOT NULL,
  address    TEXT        NOT NULL,
  label      TEXT,
  active     BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT watched_addresses_uniq UNIQUE (chain_id, address)
);

-- ------------------------------------------------------ expected payments

CREATE TYPE expected_payment_state AS ENUM (
  'upcoming',        -- due date is further away than the lead time
  'due',             -- inside the lead time, not yet satisfied
  'overdue',         -- past the due date plus grace, not satisfied
  'partially_paid',  -- 0 < settled < expected, confirmed on-chain
  'paid',            -- settled >= expected. terminal.
  'void'             -- cancelled by the merchant. terminal.
);

CREATE TYPE fulfilment_method AS ENUM ('pull', 'watch');

CREATE TABLE expected_payments (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id       BIGINT        NOT NULL REFERENCES customers(id),

  amount_expected   NUMERIC(78,0) NOT NULL CHECK (amount_expected > 0),
  -- Only ever advanced from confirmed evidence: a reconciled charge, or a
  -- matched transfer at full confirmations. Never from a broadcast.
  amount_settled    NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (amount_settled >= 0),
  currency          TEXT          NOT NULL DEFAULT 'USDC',
  token             TEXT          NOT NULL,
  chain_id          INTEGER       NOT NULL,

  due_date          TIMESTAMPTZ   NOT NULL,
  lead_time_seconds BIGINT        NOT NULL DEFAULT 259200,  -- 3 days
  grace_seconds     BIGINT        NOT NULL DEFAULT 0,

  state             expected_payment_state NOT NULL DEFAULT 'upcoming',
  fulfilment        fulfilment_method      NOT NULL,
  permission_id     BIGINT        REFERENCES permissions(id),  -- pull only
  reference         TEXT,                                      -- merchant's own reference

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT expected_payments_pull_needs_permission
    CHECK (fulfilment <> 'pull' OR permission_id IS NOT NULL)
);

CREATE INDEX expected_payments_open_idx ON expected_payments (state, due_date)
  WHERE state IN ('upcoming','due','overdue','partially_paid');
CREATE INDEX expected_payments_customer_idx ON expected_payments (customer_id);

-- --------------------------------------------------------- charges become
-- a fulfilment method rather than the top-level object. The existing
-- UNIQUE (permission_id, period_start) idempotency key is untouched.
ALTER TABLE charges ADD COLUMN expected_payment_id BIGINT REFERENCES expected_payments(id);

-- ----------------------------------------------------- incoming transfers

CREATE TYPE transfer_match_state AS ENUM (
  'pending',       -- indexed, not yet run through the matcher
  'internal',      -- originated from our own router: already reconciled as a charge
  'auto_matched',  -- exactly one unambiguous candidate
  'needs_review',  -- anything uncertain. a human resolves it.
  'resolved',      -- a human applied it
  'ignored'        -- a human said it is not a payment
);

-- Why the transfer landed where it did. Also the confidence label on a match:
-- exact_known_sender is the only value that can be written automatically.
CREATE TYPE match_reason AS ENUM (
  'router_fulfilment',           -- from our SpendRouter; never enters matching
  'exact_known_sender',          -- |X| == 1. the sole auto-match path.
  'ambiguous_multiple_exact',    -- |X| > 1
  'amount_mismatch',             -- known sender, no exact amount: partial or negotiated discount
  'unknown_sender',              -- amount matches but the sender is not linked to a customer
  'no_open_payment_for_sender',  -- sender is known, but that customer owes nothing open
  'unattributed',                -- matches nothing at all
  'manual'                       -- applied by a human in review
);

CREATE TABLE incoming_transfers (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id     INTEGER       NOT NULL,
  tx_hash      TEXT          NOT NULL,
  log_index    INTEGER       NOT NULL,
  block_number BIGINT        NOT NULL,
  -- Stored so a reorg is DETECTABLE. Deep reorg handling is not built; see the
  -- limitations page. A later scan finding a different hash at this height
  -- means the transfer below may no longer exist.
  block_hash   TEXT          NOT NULL,
  block_time   TIMESTAMPTZ,

  token        TEXT          NOT NULL,
  from_address TEXT          NOT NULL,
  to_address   TEXT          NOT NULL,
  value        NUMERIC(78,0) NOT NULL,

  match_state  transfer_match_state NOT NULL DEFAULT 'pending',
  match_reason match_reason,
  -- The evidence the matcher saw, shown verbatim in review so a human can
  -- check the decision rather than trust it.
  candidates   JSONB         NOT NULL DEFAULT '[]'::jsonb,

  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,
  indexed_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT incoming_transfers_uniq UNIQUE (tx_hash, log_index)
);

CREATE INDEX incoming_transfers_state_idx ON incoming_transfers (match_state, block_number);
CREATE INDEX incoming_transfers_sender_idx ON incoming_transfers (chain_id, from_address);

-- One transfer may satisfy more than one expected payment (a customer paying
-- two obligations at once is real), so this is many-to-many. The application
-- enforces that applied amounts never exceed the transfer's value, inside the
-- same transaction that writes the match.
CREATE TABLE payment_matches (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expected_payment_id BIGINT        NOT NULL REFERENCES expected_payments(id),
  transfer_id         BIGINT        NOT NULL REFERENCES incoming_transfers(id),
  amount_applied      NUMERIC(78,0) NOT NULL CHECK (amount_applied > 0),
  surplus             NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (surplus >= 0),
  confidence          match_reason  NOT NULL,
  matched_by          TEXT          NOT NULL,   -- 'matcher' | 'review:<who>'
  matched_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT payment_matches_uniq UNIQUE (expected_payment_id, transfer_id)
);

CREATE INDEX payment_matches_transfer_idx ON payment_matches (transfer_id);

-- Watch mode gets its own cursor. indexer_state is a CHECK-constrained
-- singleton serving the charge reconciler; sharing it would rewind that
-- reconciler and look exactly like data loss.
CREATE TABLE watch_cursors (
  name               TEXT        PRIMARY KEY,
  chain_id           INTEGER     NOT NULL,
  last_indexed_block BIGINT      NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- alerts

CREATE TABLE events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type                TEXT        NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_payment_id BIGINT      REFERENCES expected_payments(id),
  charge_id           BIGINT      REFERENCES charges(id),
  transfer_id         BIGINT      REFERENCES incoming_transfers(id),
  payload             JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX events_type_idx ON events (type, occurred_at);

CREATE TYPE delivery_channel AS ENUM ('webhook', 'email');
CREATE TYPE delivery_state   AS ENUM ('pending', 'delivered', 'failed', 'dead');

-- Webhooks and email are two channels of one destination concept, so they
-- share one retry loop rather than growing two.
CREATE TABLE alert_destinations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel     delivery_channel NOT NULL,
  target      TEXT        NOT NULL,        -- https URL, or email address
  secret      TEXT,                        -- webhook signing secret; null for email
  event_types TEXT[],                      -- null = every event
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_destinations_uniq UNIQUE (channel, target)
);

CREATE TABLE deliveries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        UUID        NOT NULL REFERENCES events(id),
  destination_id  BIGINT      NOT NULL REFERENCES alert_destinations(id),
  channel         delivery_channel NOT NULL,
  target          TEXT        NOT NULL,
  state           delivery_state NOT NULL DEFAULT 'pending',
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status     INTEGER,
  last_error      TEXT,
  transport       TEXT,                    -- which transport actually delivered
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent delivery: one attempt-chain per (event, destination), ever.
  CONSTRAINT deliveries_uniq UNIQUE (event_id, destination_id)
);

CREATE INDEX deliveries_claimable_idx ON deliveries (next_attempt_at)
  WHERE state IN ('pending', 'failed');

-- ------------------------------------------------------------- backfill
-- Every existing charge becomes a fulfilment of an expected payment. This
-- must not alter any figure shown publicly: charges.amount,
-- charges.confirmed_amount and charges.confirmed_tx_hash are read, never
-- written.

INSERT INTO customers (label)
SELECT DISTINCT 'Customer ' || substring(p.account from 1 for 10) || '…'
  FROM permissions p;

INSERT INTO customer_addresses (customer_id, chain_id, address, note)
SELECT c.id, p.chain_id, p.account, 'backfilled from permission payer account'
  FROM permissions p
  JOIN customers c ON c.label = 'Customer ' || substring(p.account from 1 for 10) || '…'
 GROUP BY c.id, p.chain_id, p.account
ON CONFLICT (chain_id, address) DO NOTHING;

INSERT INTO expected_payments
  (customer_id, amount_expected, amount_settled, token, chain_id, due_date,
   state, fulfilment, permission_id, reference, created_at)
SELECT ca.customer_id,
       ch.amount,
       COALESCE(ch.confirmed_amount, 0),
       p.token,
       p.chain_id,
       to_timestamp(ch.period_start),
       CASE WHEN ch.state = 'confirmed' THEN 'paid'::expected_payment_state
            WHEN to_timestamp(ch.period_start) < now() THEN 'overdue'::expected_payment_state
            ELSE 'due'::expected_payment_state END,
       'pull',
       ch.permission_id,
       'backfill:charge:' || ch.id,
       ch.created_at
  FROM charges ch
  JOIN permissions p        ON p.id = ch.permission_id
  JOIN customer_addresses ca ON ca.address = p.account AND ca.chain_id = p.chain_id;

UPDATE charges ch
   SET expected_payment_id = ep.id
  FROM expected_payments ep
 WHERE ep.reference = 'backfill:charge:' || ch.id;

-- Every charge must now belong to an expected payment.
ALTER TABLE charges ALTER COLUMN expected_payment_id SET NOT NULL;

-- One charge per expected payment: a pull obligation is attempted by exactly
-- one charge row (retries are attempts on that row, not new charges).
ALTER TABLE charges ADD CONSTRAINT charges_one_per_expected_payment UNIQUE (expected_payment_id);

-- Seed the merchant's receiving address from the treasury already in use.
INSERT INTO watched_addresses (chain_id, address, label)
SELECT DISTINCT p.chain_id, p.recipient, 'merchant treasury (seeded from existing permissions)'
  FROM permissions p
ON CONFLICT (chain_id, address) DO NOTHING;

COMMIT;
