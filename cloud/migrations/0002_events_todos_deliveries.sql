CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    event_date DATE NOT NULL,
    start_hhmm TEXT NOT NULL CHECK (start_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_hhmm TEXT NOT NULL CHECK (end_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    repeat_rule TEXT NOT NULL DEFAULT 'none' CHECK (repeat_rule IN ('none', 'daily', 'weekdays', 'weekly')),
    reminder_policy TEXT NOT NULL DEFAULT 'notify' CHECK (reminder_policy IN ('none', 'notify', 'alarm')),
    reminder_offset_minutes INTEGER NOT NULL DEFAULT 15 CHECK (reminder_offset_minutes BETWEEN 0 AND 1440),
    alarm_status TEXT NOT NULL DEFAULT 'NONE' CHECK (alarm_status IN ('NONE', 'QUEUED', 'EXECUTED', 'FAILED', 'MISSED')),
    source TEXT NOT NULL DEFAULT 'local',
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_hhmm < end_hhmm)
);

CREATE TABLE todos (
    todo_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    assignee TEXT NOT NULL DEFAULT 'none',
    schedule_kind TEXT NULL CHECK (schedule_kind IN ('once', 'daily', 'weekdays', 'weekly')),
    time_hhmm TEXT NULL CHECK (time_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    once_date DATE NULL,
    weekly_dow SMALLINT NULL CHECK (weekly_dow BETWEEN 0 AND 6),
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    done BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    skip_next BOOLEAN NOT NULL DEFAULT FALSE,
    alarm_status TEXT NOT NULL DEFAULT 'NONE' CHECK (alarm_status IN ('NONE', 'QUEUED', 'EXECUTED', 'FAILED', 'MISSED')),
    next_fire_at TIMESTAMPTZ NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (ttl_seconds BETWEEN 60 AND 86400),
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (assignee = 'none' AND schedule_kind IS NULL AND time_hhmm IS NULL) OR
        (assignee <> 'none' AND schedule_kind IS NOT NULL AND time_hhmm IS NOT NULL)
    )
);

CREATE INDEX idx_todos_agent_due
    ON todos (next_fire_at)
    WHERE deleted_at IS NULL AND enabled = TRUE AND assignee LIKE '@%' AND assignee <> '@me';

CREATE TABLE deliveries (
    delivery_id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL REFERENCES todos(todo_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    scheduled_for TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ NULL,
    callback_token_hash TEXT NOT NULL,
    callback_token_ciphertext TEXT NOT NULL,
    result_summary TEXT NULL,
    result_payload JSONB NULL,
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (todo_id, scheduled_for)
);

CREATE INDEX idx_deliveries_claimable
    ON deliveries (next_attempt_at)
    WHERE status IN ('PENDING', 'DISPATCHING');
