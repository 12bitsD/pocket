ALTER TABLE todos
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS external_provider TEXT NULL,
    ADD COLUMN IF NOT EXISTS external_calendar_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS external_event_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS external_etag TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_uid
    ON events (external_provider, external_event_id)
    WHERE external_provider IS NOT NULL AND external_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS external_calendar_bindings (
    provider TEXT PRIMARY KEY,
    app_id TEXT NOT NULL DEFAULT '',
    app_secret_ciphertext TEXT NOT NULL DEFAULT '',
    calendar_id TEXT NOT NULL DEFAULT '',
    access_token_ciphertext TEXT NOT NULL DEFAULT '',
    refresh_token_ciphertext TEXT NOT NULL DEFAULT '',
    token_expires_at TIMESTAMPTZ NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_synced_at TIMESTAMPTZ NULL,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    return_to TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
