-- 我懷念的－純伴奏 was made private on YouTube; point it at a playable backing track.
-- Pairing offsets for the song reset because the new video's timing differs.
UPDATE song_partner SET offset_ms = 0
  WHERE seen_id IN (SELECT id FROM seen WHERE video_id = '4n8KJ8nRSEk')
     OR partner_id IN (SELECT id FROM seen WHERE video_id = '4n8KJ8nRSEk');
UPDATE seen SET video_id = 'UHS8kRuWGq4', youtube_url = 'https://www.youtube.com/watch?v=UHS8kRuWGq4'
  WHERE video_id = '4n8KJ8nRSEk';
