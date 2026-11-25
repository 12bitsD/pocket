CREATE TABLE tokens (
    token_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'web', 'device', 'agent')),
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT[] NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pairing_codes (
    code_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    claimed_token_id TEXT NULL REFERENCES tokens(token_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency (
    method TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (method, request_id)
);

CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY CHECK (agent_id ~ '^@[a-z0-9][a-z0-9_-]{1,30}$' AND agent_id <> '@me'),
    name TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    credential_ciphertext TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
