-- Sparar global app-state (t.ex. Roaring-importens pagineringscursor).
-- Kör i Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;
