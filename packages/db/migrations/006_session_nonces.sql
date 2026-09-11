-- Sign-in nonces: single use, five minutes, bound to the address and origin they were issued for.
--
-- The server rebuilds the exact message from this row when verifying, so a client can never
-- substitute its own origin, address or times. Times are unix seconds, not timestamps, because
-- they are signed as uint64 and must round-trip exactly. Additive only.
CREATE TABLE session_nonces (
  nonce       TEXT   PRIMARY KEY,
  address     TEXT   NOT NULL,
  origin      TEXT   NOT NULL,
  issued_at   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     TIMESTAMPTZ,
  ip_hash     TEXT   NOT NULL
);

CREATE INDEX session_nonces_ip_idx ON session_nonces (ip_hash, issued_at);
