-- 原唱／伴唱: each song can point at its other version (vocal original or karaoke track).
-- offset_ms is how far ahead the partner video is at the same moment in the song.
CREATE TABLE song_partner (
  seen_id INTEGER PRIMARY KEY REFERENCES seen(id),
  partner_id INTEGER NOT NULL REFERENCES seen(id),
  offset_ms INTEGER NOT NULL DEFAULT 0
);
-- Set while the playing queue item has been switched to its partner version.
ALTER TABLE queue ADD COLUMN use_partner BOOLEAN NOT NULL DEFAULT false;
