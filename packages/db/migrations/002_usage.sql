-- Minimal metering support. Deliberately NOT a plans/products model -- just
-- enough to prove that a charge amount can be computed at charge time rather
-- than fixed at enqueue time, which is the capability metered billing rests on.
BEGIN;

CREATE TABLE usage_records (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_id  BIGINT      NOT NULL REFERENCES permissions(id),
  period_start   BIGINT      NOT NULL,
  units          NUMERIC(78,0) NOT NULL,
  unit_price     NUMERIC(78,0) NOT NULL,   -- token base units per unit
  note           TEXT,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX usage_records_lookup_idx ON usage_records (permission_id, period_start);

COMMIT;
