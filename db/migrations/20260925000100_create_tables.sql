-- Online (Netlify) schema. Same shape as the local SQLite tables, plus rooms:
-- each room has its own queue and history; the song catalogue and lyrics are shared.
CREATE TABLE seen (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  youtube_url TEXT NOT NULL,
  video_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX seen_video ON seen(video_id);

CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  host_token TEXT NOT NULL UNIQUE,
  guest_token TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE queue (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  seen_id INTEGER NOT NULL REFERENCES seen(id),
  status TEXT NOT NULL CHECK (status IN ('pending','playing','done','removed')),
  sort_order INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT
);
CREATE INDEX queue_room_active ON queue(room_id, status, sort_order);
CREATE INDEX queue_seen ON queue(seen_id);

CREATE TABLE lyrics (
  seen_id INTEGER PRIMARY KEY REFERENCES seen(id),
  lrclib_id BIGINT,
  track TEXT,
  synced TEXT,
  offset_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
