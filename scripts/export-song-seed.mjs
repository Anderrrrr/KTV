import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const databasePath = path.join(root, 'data', 'ktv.sqlite');
const outputDirectory = path.join(root, 'seed');
const outputPath = path.join(outputDirectory, 'songs.json');

if (!fs.existsSync(databasePath)) throw new Error('找不到 data/ktv.sqlite');

const db = new DatabaseSync(databasePath, { readOnly: true });
const songs = db.prepare(`
  SELECT title, youtube_url AS youtubeUrl, video_id AS videoId
  FROM seen
  ORDER BY title COLLATE NOCASE, id
`).all();
db.close();

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(songs, null, 2)}\n`, 'utf8');
console.log(`已匯出 ${songs.length} 首歌曲到 ${outputPath}`);
