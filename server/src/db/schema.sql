-- ProxyProof: bilateral trust verification for agentic commerce.
-- Identity, delegation, transaction authorization and payment completion are kept in separate tables on purpose.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS server_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  -- Fault injection for the revocation status service, so judges can see the layer fail closed.
  status_service TEXT NOT NULL DEFAULT 'UP' CHECK (status_service IN ('UP','DOWN')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY (workspace_id, user_id));
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), expires_at TEXT NOT NULL);

-- A principal is the business or person an agent acts for. Its identity is verified independently of any agent.
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('BUYER','SELLER')),
  did TEXT NOT NULL, public_jwk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','UNVERIFIED','SUSPENDED')),
  verification_method TEXT,
  -- Sellers: the PayPal account the business enrolled. Buyers: the billing contact for payment requests.
  payment_account TEXT,
  key_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (key_status IN ('ACTIVE','REVOKED')),
  key_created_at TEXT, key_revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, did)
);
-- Demo custody of principal signing keys. Read only when an authenticated human approves on the principal's behalf.
CREATE TABLE IF NOT EXISTS principal_keys (principal_id TEXT PRIMARY KEY REFERENCES principals(id), private_pem TEXT NOT NULL);

-- An agent is a key pair that claims to act for a principal. Registration alone grants nothing.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('BUYER','SELLER')),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  did TEXT NOT NULL, public_jwk TEXT NOT NULL, thumbprint TEXT NOT NULL,
  -- Where the agent was created, and how it reaches ProxyProof. Assurance says what the connection actually proves.
  provider TEXT NOT NULL DEFAULT 'Custom',
  connection TEXT NOT NULL CHECK (connection IN ('TEST_RUNTIME','API','MCP')),
  assurance TEXT NOT NULL,
  connection_token_hash TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT,
  UNIQUE (workspace_id, did)
);
-- Private keys of agents run by the built-in test runtime. The verifier never reads this table.
CREATE TABLE IF NOT EXISTS runtime_agent_keys (agent_id TEXT PRIMARY KEY REFERENCES agents(id), private_pem TEXT NOT NULL);

-- A delegation is a credential signed by the principal's key. Requested first, then approved by a human.
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id), principal_id TEXT NOT NULL REFERENCES principals(id),
  mandate TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','REVOKED','SUPERSEDED','DECLINED')),
  -- Sub-delegation: issued by a parent agent's authority, never wider than it. Revoking a parent revokes its children.
  parent_id TEXT REFERENCES delegations(id),
  credential TEXT, credential_hash TEXT, revoked_reason TEXT,
  requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
  approved_by TEXT, approved_at TEXT, revoked_by TEXT, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS delegations_agent ON delegations (agent_id, status);

-- Single-use challenges for proof of possession and replay protection.
CREATE TABLE IF NOT EXISTS challenges (
  nonce TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent_did TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_by TEXT, used_at TEXT
);

-- One bilateral commercial transaction: the seller agent's offer and the buyer agent's acceptance of the same terms.
-- The decision (ALLOW/HOLD/REVIEW/DENY) and the payment state are separate columns on purpose.
CREATE TABLE IF NOT EXISTS commerce_transactions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL DEFAULT 1, history TEXT NOT NULL DEFAULT '[]',
  terms TEXT, terms_hash TEXT, document TEXT, reference TEXT, amount_minor INTEGER, currency TEXT,
  seller_org_id TEXT REFERENCES principals(id), buyer_org_id TEXT REFERENCES principals(id),
  seller_agent_id TEXT REFERENCES agents(id), buyer_agent_id TEXT REFERENCES agents(id),
  seller_evidence TEXT NOT NULL, buyer_evidence TEXT,
  match TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW','HOLD','REVIEW','DENY')),
  reasons TEXT NOT NULL, decision_receipt TEXT NOT NULL,
  review_approval TEXT, reviewed_by TEXT, reviewed_at TEXT,
  payment_state TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (payment_state IN ('NOT_STARTED','AWAITING_BUYER_APPROVAL','CAPTURE_SUBMITTED','COMPLETED','FAILED','CANCELLED')),
  label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ctx_ws ON commerce_transactions (workspace_id, created_at);

-- Execution permits: single use, short lived, bound to one terms hash and one action.
CREATE TABLE IF NOT EXISTS execution_permits (
  jti TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), transaction_id TEXT NOT NULL REFERENCES commerce_transactions(id),
  terms_hash TEXT NOT NULL, action TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_at TEXT, used_result TEXT
);

-- Payment provider attempts. One live attempt per transaction, created only by the executor with a valid permit.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), transaction_id TEXT NOT NULL REFERENCES commerce_transactions(id),
  permit_jti TEXT NOT NULL, terms_hash TEXT NOT NULL, rail TEXT NOT NULL CHECK (rail IN ('ORDERS')),
  status TEXT NOT NULL CHECK (status IN ('CREATED','AWAITING_BUYER_APPROVAL','APPROVED','CAPTURE_SUBMITTED','COMPLETED','FAILED','UNKNOWN')),
  idempotency_key TEXT NOT NULL UNIQUE, provider_ref TEXT, provider_status TEXT, payer_link TEXT,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, failure TEXT, confirmed_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt ON payment_attempts (transaction_id) WHERE status <> 'FAILED';

CREATE TABLE IF NOT EXISTS provider_events (
  id TEXT PRIMARY KEY, provider_event_id TEXT UNIQUE, event_type TEXT, verified INTEGER NOT NULL,
  attempt_id TEXT, rejection TEXT, payload_sha256 TEXT NOT NULL, received_at TEXT NOT NULL
);

-- Hash-chained audit log, one chain per workspace.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), seq INTEGER NOT NULL,
  event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, subject_id TEXT,
  payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, seq)
);

-- Scenario runs: each run plays a scenario in its own isolated workspace; the owner is the session's workspace.
CREATE TABLE IF NOT EXISTS lab_runs (id TEXT PRIMARY KEY, owner_workspace_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scenario_id TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lab_runs_owner ON lab_runs (owner_workspace_id, created_at);
