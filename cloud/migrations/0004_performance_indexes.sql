CREATE INDEX idx_events_active_window
    ON events (event_date ASC, start_hhmm ASC, event_id ASC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_events_active_repeating
    ON events (event_date ASC, start_hhmm ASC, event_id ASC)
    WHERE deleted_at IS NULL AND repeat_rule <> 'none';

CREATE INDEX idx_todos_active_list
    ON todos (done ASC, updated_at DESC, todo_id ASC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_todos_me_queued_once
    ON todos (once_date ASC, time_hhmm ASC)
    INCLUDE (todo_id, timezone, revision)
    WHERE assignee = '@me'
      AND schedule_kind = 'once'
      AND done = FALSE
      AND enabled = TRUE
      AND alarm_status = 'QUEUED'
      AND deleted_at IS NULL;

CREATE INDEX idx_deliveries_todo_latest
    ON deliveries (
        todo_id ASC,
        created_at DESC,
        scheduled_for DESC,
        delivery_id DESC
    )
    INCLUDE (status, result_summary, completed_at);

CREATE INDEX idx_tokens_created_desc
    ON tokens (created_at DESC, token_id DESC);
