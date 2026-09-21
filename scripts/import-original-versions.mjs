import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const databasePath = path.join(root, 'data', 'ktv.sqlite');
if (!fs.existsSync(databasePath)) throw new Error('找不到 data/ktv.sqlite');

const originals = [
  ['vBNujgTUkfU', '生日快樂', 'C0aECv8soHo', '生日快樂－人聲版'],
  ['t8UR4V1jI8k', '我很好騙', '3HsIaWuNeX0', '我很好騙－原唱'],
  ['ATPdr-yu7KI', '忠孝東路走九遍', 'hFJAzTqYFHc', '忠孝東路走九遍－原唱'],
  ['SxFFvvSvsmg', '浪流連', '3Y0Ut5ozaKs', '浪流連－原唱'],
  ['Ek3cwQJmN2c', 'Without You', 'HQDDlgGy2hg', 'Without You－原唱'],
  ['rW2olcCQ2qs', '阿拉斯加海灣', 'kU0oHbP4ZDk', '阿拉斯加海灣－原唱'],
  ['_BHBQaqKiBY', '連名帶姓', 'qf09H2xFq2s', '連名帶姓－原唱'],
  ['4n8KJ8nRSEk', '我懷念的', 'k_9GssEHzTc', '我懷念的－原唱'],
  ['b6Sb2IpxZAY', '幸福了 然後呢', 'm9eoYjo5W8c', '幸福了 然後呢－原唱'],
  ['tvox2-3K0Os', '以後別做朋友', 'Ew4VvF0DPMc', '以後別做朋友－原唱'],
  ['Yon5C5XWo1M', '失落沙洲', 'Ie1KcGvBN_k', '失落沙洲－原唱'],
  ['UDyyGrbtIl0', '家家酒', 'T-Xk_xirUlo', '家家酒－原唱'],
  ['Pjd_wX4JN4E', '你就不要想起我', 'GsKbnsUN2RE', '你就不要想起我－原唱'],
  ['L2x8DRn4Fu4', '500天', 'B5ner2-oBGQ', '500天－原唱'],
  ['i8evxzFgd4k', '手心的薔薇', 'onYP5u0b3yw', '手心的薔薇－原唱'],
  ['Yn4rOgBQi5c', '也可以', 'lN-GUBIMDNA', '也可以－原唱'],
  ['XNJp-yastws', '對等關係', 'mQUek1GYfvs', '對等關係－原唱'],
  ['zz8L71M2r-8', '慢慢喜歡你', 'kqqraGvoqVs', '慢慢喜歡你－原唱'],
  ['J_Lr66SPd8U', '你敢不敢', 'HLibG1_lcTk', '你敢不敢－原唱'],
  ['qEx-Fo5W_9c', '我還是愛著你', 'Oc_VUUE9MHo', '我還是愛著你－原唱'],
  ['tjLVawktlxQ', '沒有第三者的分手', 'cbQi3MU4CRI', '沒有第三者的分手－原唱'],
  ['xo-yoeXKB4I', '有一種悲傷', 'BRcudpJzy1I', '有一種悲傷－原唱']
];

const db = new DatabaseSync(databasePath);
const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const backupPath = path.join(root, 'data', `ktv-before-originals-${stamp}.sqlite`);
db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);

const findByVideo = db.prepare('SELECT id,title FROM seen WHERE video_id=?');
const rename = db.prepare('UPDATE seen SET title=? WHERE video_id=?');
const insert = db.prepare('INSERT INTO seen(title,youtube_url,video_id) VALUES(?,?,?)');

let renamed = 0;
let added = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const [backingId, baseTitle, originalId, originalTitle] of originals) {
    const backing = findByVideo.get(backingId);
    if (!backing) throw new Error(`找不到伴奏版：${baseTitle} (${backingId})`);
    if (!backing.title.endsWith('－純伴奏')) {
      rename.run(`${baseTitle}－純伴奏`, backingId);
      renamed += 1;
    }
    if (!findByVideo.get(originalId)) {
      insert.run(originalTitle, `https://www.youtube.com/watch?v=${originalId}`, originalId);
      added += 1;
    }
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}

console.log(JSON.stringify({ renamed, added, backupPath }, null, 2));
