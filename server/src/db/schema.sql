PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS server_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('STANDARD','DEMO','CHALLENGE')),
  parent_id TEXT REFERENCES workspaces(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('OWNER','FINANCE_ADMIN','REVIEWER','AUDITOR')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, normalized_name TEXT NOT NULL, country TEXT, business_id TEXT,
  domains TEXT NOT NULL DEFAULT '[]', currencies TEXT NOT NULL DEFAULT '["USD"]', categories TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('PENDING','VERIFIED','SUSPENDED','REVOKED')),
  created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, normalized_name)
);
CREATE TABLE IF NOT EXISTS vendor_contacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), vendor_id TEXT NOT NULL REFERENCES vendors(id),
  email TEXT NOT NULL, name TEXT, verification_method TEXT, verified_at TEXT,
  UNIQUE (vendor_id, email)
);
CREATE TABLE IF NOT EXISTS vendor_destinations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), vendor_id TEXT NOT NULL REFERENCES vendors(id),
  type TEXT NOT NULL CHECK (type IN ('PAYPAL_EMAIL','IBAN','BANK_ACCOUNT','OTHER')), value TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','REVOKED')),
  verified_by TEXT, verified_at TEXT, verification_method TEXT,
  UNIQUE (vendor_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS vendor_verifications (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), vendor_id TEXT NOT NULL REFERENCES vendors(id),
  kind TEXT NOT NULL, method TEXT NOT NULL, notes TEXT, verified_by TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
  principal_user_id TEXT NOT NULL REFERENCES users(id), public_key_pem TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')), last_seen_at TEXT, created_at TEXT NOT NULL
);
-- Private keys kept only so the in-app agent simulator can sign. Never read by the pipeline or executor.
CREATE TABLE IF NOT EXISTS simulator_agent_keys (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id), private_key_pem TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_authorizations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL, principal_user_id TEXT NOT NULL,
  actions TEXT NOT NULL, categories TEXT NOT NULL, vendor_ids TEXT NOT NULL, currencies TEXT NOT NULL,
  per_tx_max_minor INTEGER NOT NULL, daily_budget_minor INTEGER NOT NULL, monthly_budget_minor INTEGER NOT NULL,
  policy_version INTEGER NOT NULL, expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','SUPERSEDED')),
  token TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (agent_id, version)
);
CREATE TABLE IF NOT EXISTS agent_nonces (
  agent_id TEXT NOT NULL, nonce TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (agent_id, nonce)
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id), current_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_versions (
  policy_id TEXT NOT NULL REFERENCES policies(id), workspace_id TEXT NOT NULL, version INTEGER NOT NULL,
  rules TEXT NOT NULL, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, version)
);
CREATE TRIGGER IF NOT EXISTS policy_versions_no_update BEFORE UPDATE ON policy_versions
BEGIN SELECT RAISE(ABORT, 'policy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS policy_versions_no_delete BEFORE DELETE ON policy_versions
BEGIN SELECT RAISE(ABORT, 'policy versions are immutable'); END;

CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  origin TEXT NOT NULL CHECK (origin IN ('HUMAN','AGENT')),
  principal_id TEXT, submitted_by TEXT, agent_id TEXT, claimed_agent_id TEXT, authorization_id TEXT, authorization_version INTEGER,
  agent_check TEXT, -- JSON result of signature and grant verification, or null for humans.
  status TEXT NOT NULL CHECK (status IN ('RECEIVED','EXTRACTING','INVESTIGATING','EVALUATED','READY_FOR_CONFIRMATION','AWAITING_REVIEW','ON_HOLD','DENIED','EXECUTING','PAYMENT_PENDING','COMPLETED','FAILED','REJECTED')),
  revision INTEGER NOT NULL DEFAULT 1,
  vendor_id TEXT REFERENCES vendors(id), payee_name TEXT,
  destination_type TEXT, destination_value TEXT, destination_fingerprint TEXT,
  amount_minor INTEGER, currency TEXT, category TEXT, purpose TEXT, invoice_id TEXT,
  rail TEXT NOT NULL DEFAULT 'PAYOUTS' CHECK (rail IN ('PAYOUTS','ORDERS')),
  evidence_bundle_id TEXT, facts TEXT, summary TEXT, label TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_requests_ws ON payment_requests (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS source_artifacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), payment_request_id TEXT NOT NULL REFERENCES payment_requests(id),
  kind TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  parent_artifact_id TEXT, text_excerpt TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), payment_request_id TEXT REFERENCES payment_requests(id),
  vendor_id TEXT REFERENCES vendors(id), vendor_name TEXT, number TEXT, normalized_number TEXT,
  invoice_date TEXT, due_date TEXT, currency TEXT, total_minor INTEGER, subtotal_minor INTEGER, tax_minor INTEGER,
  purchase_order TEXT, file_fingerprint TEXT, semantic_fingerprint TEXT, extraction TEXT, is_seed_history INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_lookup ON invoices (workspace_id, normalized_number);
CREATE INDEX IF NOT EXISTS invoices_file ON invoices (workspace_id, file_fingerprint);
CREATE INDEX IF NOT EXISTS invoices_semantic ON invoices (workspace_id, semantic_fingerprint);
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  description TEXT, quantity TEXT, unit_price_minor INTEGER, amount_minor INTEGER
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payment_request_id TEXT NOT NULL REFERENCES payment_requests(id),
  bundle_id TEXT NOT NULL, source TEXT NOT NULL, retrieved_at TEXT NOT NULL, claim TEXT NOT NULL,
  stance TEXT NOT NULL CHECK (stance IN ('SUPPORTS','CONTRADICTS','UNKNOWN','NEUTRAL')),
  provenance TEXT NOT NULL CHECK (provenance IN ('TRUSTED_REGISTRY','HISTORY','USER_PROVIDED','PROVIDER_CONFIRMED','PUBLIC_SOURCE','MODEL_INFERRED','SYSTEM_COMPUTED')),
  reliability TEXT NOT NULL CHECK (reliability IN ('HIGH','MEDIUM','LOW')),
  confidence REAL, limitations TEXT, artifact_hash TEXT, details TEXT
);
CREATE TABLE IF NOT EXISTS risk_findings (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payment_request_id TEXT NOT NULL REFERENCES payment_requests(id),
  bundle_id TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  title TEXT NOT NULL, explanation TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('RULE','MODEL')), evidence_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payment_request_id TEXT NOT NULL REFERENCES payment_requests(id),
  revision INTEGER NOT NULL, transaction_fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW','REVIEW','HOLD','DENY')),
  reasons TEXT NOT NULL, policy_version INTEGER NOT NULL, facts TEXT NOT NULL,
  signature TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS decisions_req ON policy_decisions (payment_request_id, created_at DESC);
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payment_request_id TEXT NOT NULL REFERENCES payment_requests(id),
  decision_id TEXT NOT NULL REFERENCES policy_decisions(id), transaction_fingerprint TEXT NOT NULL, reasons TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','APPROVED','REJECTED','INVALIDATED')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, approval_request_id TEXT NOT NULL REFERENCES approval_requests(id),
  payment_request_id TEXT NOT NULL, approver_user_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('APPROVE','REJECT')),
  transaction_fingerprint TEXT NOT NULL, amount_minor INTEGER, currency TEXT, destination_fingerprint TEXT, invoice_fingerprint TEXT,
  policy_version INTEGER NOT NULL, reviewed_codes TEXT NOT NULL DEFAULT '[]', comment TEXT, invalidated_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payment_request_id TEXT REFERENCES payment_requests(id), decision_id TEXT,
  payment_key TEXT NOT NULL, transaction_fingerprint TEXT, rail TEXT NOT NULL, invoice_id TEXT, agent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('CREATED','APPROVED','CAPTURE_PENDING','COMPLETED','FAILED','REFUNDED','UNKNOWN')),
  provider TEXT NOT NULL CHECK (provider IN ('PAYPAL_SANDBOX','SEED_HISTORY')),
  provider_ref TEXT, provider_item_ref TEXT, approve_url TEXT, idempotency_key TEXT NOT NULL,
  vendor_id TEXT, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, provider_status TEXT, failure TEXT,
  confirmed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- One live or successful payment per business key. A definite provider failure frees the key.
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_live ON payment_attempts (workspace_id, payment_key) WHERE status <> 'FAILED';
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_decision ON payment_attempts (decision_id) WHERE decision_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS gate_log (
  id TEXT PRIMARY KEY, workspace_id TEXT, payment_request_id TEXT, decision_id TEXT, actor TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('PASSED','REFUSED')), reason_code TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_events (
  id TEXT PRIMARY KEY, provider_event_id TEXT, event_type TEXT, verified INTEGER NOT NULL, rejection TEXT,
  attempt_id TEXT, payload_sha256 TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_events_once ON provider_events (provider_event_id) WHERE verified = 1;

-- Hash-chained, append-only audit ledger. Triggers block edits; the chain detects edits made around them.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT, payment_request_id TEXT, payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, seq)
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TABLE IF NOT EXISTS challenge_scenarios (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL,
  expected TEXT NOT NULL, label TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS challenge_runs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), batch_id TEXT NOT NULL, scenario_id TEXT NOT NULL,
  sandbox_workspace_id TEXT, payment_request_id TEXT, expected TEXT NOT NULL, actual TEXT, passed INTEGER,
  category TEXT NOT NULL, executor_called INTEGER NOT NULL DEFAULT 0, details TEXT, created_at TEXT NOT NULL
);
