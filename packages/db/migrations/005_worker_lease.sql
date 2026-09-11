-- One worker at a time.
--
-- Railway starts a new deployment before stopping the old one (about 3.7 s observed),
-- and restarts a crashed worker while its predecessor may still look alive. A worker
-- ticks only while it holds this lease, and every transaction that creates or retires
-- a charge attempt re-checks it. Additive only: no existing table is touched.
CREATE TABLE worker_lease (
  name        TEXT        PRIMARY KEY,
  holder      TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
