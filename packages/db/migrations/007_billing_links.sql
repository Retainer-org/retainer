-- Billing links: the terms a merchant offers, carried by the link the customer opens.
--
-- A customer never types an address into a browser; they open a link their merchant sent.
-- The link row holds the exact terms, and registration pins them from here -- never from the
-- client. Additive only: one new table, one nullable column; no existing row is touched.
CREATE TYPE first_charge_rule AS ENUM ('at_signup', 'end_of_first_period', 'none');

CREATE TABLE billing_links (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token                 TEXT          NOT NULL UNIQUE,              -- 128-bit random, base64url: /pay/<token>
  merchant_name         TEXT          NOT NULL CHECK (length(merchant_name) BETWEEN 1 AND 80),  -- what the link calls the merchant; not verified
  treasury              TEXT          NOT NULL,                      -- where the money goes; encoded into the permission's extraData
  chain_id              INTEGER       NOT NULL,
  allowance             NUMERIC(78,0) NOT NULL CHECK (allowance > 0),
  period_seconds        INTEGER       NOT NULL CHECK (period_seconds >= 3600),
  duration_seconds      INTEGER       NOT NULL CHECK (duration_seconds >= period_seconds),
  start_at              BIGINT,                                      -- NULL: the permission starts when the customer signs
  first_charge          first_charge_rule NOT NULL,
  first_charge_amount   NUMERIC(78,0),
  expires_at            TIMESTAMPTZ   NOT NULL,                      -- when the link stops accepting new sign-ups
  single_use            BOOLEAN       NOT NULL DEFAULT false,
  used_at               TIMESTAMPTZ,
  used_by_permission_id BIGINT        REFERENCES permissions(id),
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by            TEXT          NOT NULL,
  CONSTRAINT billing_links_first_charge_amount CHECK (
    (first_charge = 'none') = (first_charge_amount IS NULL)
    AND (first_charge_amount IS NULL OR (first_charge_amount > 0 AND first_charge_amount <= allowance)))
);

ALTER TABLE permissions ADD COLUMN link_id BIGINT REFERENCES billing_links(id);
CREATE INDEX permissions_link_idx ON permissions (link_id) WHERE link_id IS NOT NULL;
