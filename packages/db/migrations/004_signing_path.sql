-- Phase 3: record HOW a permission was signed.
--
-- Two signing paths now exist, and debugging needs to tell them apart:
--   base_account -- signed through Coinbase's hosted consent screen (Base Account SDK)
--   eoa_owned    -- signed as CoinbaseSmartWalletMessage typed data by an externally
--                   owned account (MetaMask or another injected wallet) that owns a
--                   CoinbaseSmartWallet created for it
--
-- Additive only. Rows that already exist keep NULL in all three columns: they were
-- written before this was recorded, and backfilling a guess would make the column
-- claim something nobody verified.

BEGIN;

CREATE TYPE signing_path AS ENUM ('base_account', 'eoa_owned');

ALTER TABLE permissions
  ADD COLUMN signing_path         signing_path,
  ADD COLUMN signer_eoa           TEXT,
  -- sha256 of the registering client's IP. Used only to rate-limit registrations,
  -- which cost the executor gas. The address itself is never stored.
  ADD COLUMN registration_ip_hash TEXT;

-- An EOA-owned permission without its owner is unrecoverable for debugging and
-- for revocation, so the schema refuses it.
ALTER TABLE permissions ADD CONSTRAINT permissions_eoa_owned_needs_signer
  CHECK (signing_path IS DISTINCT FROM 'eoa_owned' OR signer_eoa IS NOT NULL);

-- The rate limits look back over a short window by signer and by client.
CREATE INDEX permissions_signer_recent_idx
  ON permissions (lower(signer_eoa), created_at) WHERE signer_eoa IS NOT NULL;
CREATE INDEX permissions_ip_recent_idx
  ON permissions (registration_ip_hash, created_at) WHERE registration_ip_hash IS NOT NULL;

COMMIT;
