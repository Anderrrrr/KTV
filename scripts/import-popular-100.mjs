import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const databasePath = path.join(root, 'data', 'ktv.sqlite');
if (!fs.existsSync(databasePath)) throw new Error('找不到 data/ktv.sqlite');

// 依台灣 KTV 點播榜與常點經典整理；每筆連結皆核對過 YouTube 搜尋結果。
const songs = [
  ['擱淺', '周杰倫', 'YJfHuATJYsQ'],
  ['天后', '陳勢安', 'dvW1rPD0-nQ'],
  ['新不了情', '萬芳', 'JBg21ECQe6Y'],
  ['淚橋', '伍佰', 'pv9IIaXHsvA'],
  ['雨愛', '楊丞琳', 'oec9R5ypf-o'],
  ['愛錯', '王力宏', 's8j7IITNw1o'],
  ['倒帶', '蔡依林', 'lnlNpy3RmAI'],
  ['如果可以', '韋禮安', '8MG--WuNW1Y'],
  ['慢冷', '梁靜茹', '2LuW7acW9B8'],
  ['特別的人', '方大同', 'JCk1ga9CV2I'],
  ['幾分之幾', '盧廣仲', 'HQ_mU73VhEQ'],
  ['開始懂了', '孫燕姿', 'h5eRbbOnPRc'],
  ['多遠都要在一起', 'G.E.M. 鄧紫棋', 'D9ksLn6hZ7Q'],
  ['泡沫', 'G.E.M. 鄧紫棋', 'mGeiABBB5f8'],
  ['摯友', 'A-Lin', 'vGqpGFH3vh8'],
  ['十年', '陳奕迅', '5EWIh3msNdU'],
  ['妥協', '蔡依林', 'M00rcJ9gMEc'],
  ['給我一個理由忘記', 'A-Lin', 'cSwRe9CYj2Y'],
  ['日不落', '蔡依林', '1GA8z-Wliew'],
  ['修煉愛情', '林俊傑', '9nsqDj5rsrg'],
  ['愛我還是他', '陶喆', 'PdUF-kSMmAU'],
  ['訣愛', '詹雯婷 Faye', 'AsXtYDiwdbw'],
  ['嘉賓', '張遠', '7lpvIv_4yH8'],
  ['在加納共和國離婚', '菲道爾、大穎', 'wlSvIL-H1GQ'],
  ['離開的一路上', '理想混蛋', 'sIum5n8pG28'],
  ['想和你看五月的晚霞', '陳華', 'ljd9ISixsWo'],
  ['愛愛愛', '方大同', '812omgU1tHs'],
  ['愛人錯過', '告五人', 'XlaZ3-Jnmzs'],
  ['辣台妹', '頑童MJ116', 'zJx6v_APhWA'],
  ['Last Dance', '伍佰', '7jYDYon4sGQ'],
  ['小幸運', '田馥甄', 'XIYTWH_iUqU'],
  ['可惜不是你', '梁靜茹', 'k_l7FVsqUyM'],
  ['會呼吸的痛', '梁靜茹', 'vZ1fCcPUuPM'],
  ['勇氣', '梁靜茹', 'nDchQNPuA0k'],
  ['情歌', '梁靜茹', '7FiQV1-z06Q'],
  ['分手快樂', '梁靜茹', 'd0ZO-FRuZqU'],
  ['淘汰', '陳奕迅', 'N0lMO59C79A'],
  ['愛情轉移', '陳奕迅', 'H0X3Nn0oAD4'],
  ['記得', '張惠妹', 'qm3wIQWnXxg'],
  ['人質', '張惠妹', 'K5rjNK_De-I'],
  ['我要快樂', '張惠妹', 'NilgON1msY8'],
  ['聽海', '張惠妹', 'mLk61pfiHQ0'],
  ['江南', '林俊傑', 'G97_rOdHcnY'],
  ['可惜沒如果', '林俊傑', '-5OO4hov_l4'],
  ['不為誰而作的歌', '林俊傑', 'gd38-X3HpbM'],
  ['她說', '林俊傑', 'C8fVp87PKMA'],
  ['珊瑚海', '周杰倫、梁心頤', 'kYhh1PpsOg4'],
  ['廣島之戀', '張洪量、莫文蔚', 'Jj_ImFUqz4s'],
  ['你那麼愛她', '林隆璇、李聖傑', 'dy70lVVxhh4'],
  ['梁山伯與茱麗葉', '卓文萱、曹格', '0NuKS4gK0Lw'],
  ['千年之戀', '信樂團、戴愛玲', '8fo5H8ADV58'],
  ['不該', '周杰倫、張惠妹', '_VxLOj3TB5k'],
  ['挪威的森林', '伍佰', 'gPpZJlE0Ca8'],
  ['浪人情歌', '伍佰', 'OPkqtboFFYI'],
  ['戀人未滿', 'S.H.E', 'jL6D7rqk4SQ'],
  ['Super Star', 'S.H.E', 'gr5fNKK2FaA'],
  ['Lydia', 'F.I.R. 飛兒樂團', 'ZOHsd6Zk7DM'],
  ['我們的愛', 'F.I.R. 飛兒樂團', '88D2-J_pk7A'],
  ['月牙灣', 'F.I.R. 飛兒樂團', 'sZXE20ScmPY'],
  ['我難過', '5566', '2l4X4lGP_Zk'],
  ['隱形的翅膀', '張韶涵', 'be2wvNFTLMc'],
  ['遺失的美好', '張韶涵', 'Jho1RSx32ns'],
  ['歐若拉', '張韶涵', 'dmwJaG-R1iM'],
  ['離開地球表面', '五月天', 'FWAh3O-OF-o'],
  ['傷心的人別聽慢歌', '五月天', 'slLPIcLe2E0'],
  ['戀愛ing', '五月天', 'iSkRGgYSQfY'],
  ['突然好想你', '五月天', 'GtDRcXtDg-4'],
  ['想見你想見你想見你', '八三夭', '4iRupuNet3Q'],
  ['東區東區', '八三夭', 'qVKLNfbpCZ0'],
  ['失戀無罪', 'A-Lin', 'q3srM8Wed_Q'],
  ['寂寞寂寞就好', '田馥甄', 'DyFIzKYQQYE'],
  ['還是要幸福', '田馥甄', '1CcQDuuhdXA'],
  ['Letting Go', '蔡健雅', '2ByPpQbNzwk'],
  ['無底洞', '蔡健雅', 'uAbK2Hq248I'],
  ['最初的夢想', '范瑋琪', 'wGAmgmZg-48'],
  ['一個像夏天一個像秋天', '范瑋琪', '2-sqX7JiIjA'],
  ['帶我走', '楊丞琳', '3gf6HYjlFzA'],
  ['曖昧', '楊丞琳', 'mebzXfWi87E'],
  ['匿名的好友', '楊丞琳', 's9hGDIpwfXw'],
  ['天空', '蔡依林', 'hmyEkTioX5E'],
  ['說愛你', '蔡依林', '_Y_mlCbfn_Y'],
  ['遇見', '孫燕姿', 'zgmnU8BxE2c'],
  ['天黑黑', '孫燕姿', 'cxDG3Ex9z6Y'],
  ['我不難過', '孫燕姿', 'GDsyUtdS1YM'],
  ['逆光', '孫燕姿', 'JCqJcK3v4q0'],
  ['最熟悉的陌生人', '蕭亞軒', 'C5mI0TqrJ-4'],
  ['錯的人', '蕭亞軒', '54yKHYSwJcQ'],
  ['一個人的精彩', '蕭亞軒', '2e1gJOE9ZEQ'],
  ['當你', '王心凌', 'Es2b6sM2nrs'],
  ['大眠', '王心凌', 'VS1lvYuW3LQ'],
  ['愛你', '王心凌', 'NAODcPQcy9U'],
  ['第一次愛的人', '王心凌', '6j5fLo2c9IY'],
  ['光年之外', 'G.E.M. 鄧紫棋', 'T4SimnaiktU'],
  ['倒數', 'G.E.M. 鄧紫棋', 'ma7r2HGqwXs'],
  ['告白氣球', '周杰倫', 'bu7nU9Mhpyo'],
  ['晴天', '周杰倫', 'DYptgVvkVLQ'],
  ['不能說的秘密', '周杰倫', 'uIWypArI73w'],
  ['童話', '光良', 'bBcp_ljCBGU'],
  ['唯一', '王力宏', 'P7Qv4AV_StM'],
  ['依然愛你', '王力宏', 'sU_ByeHJtw8']
];

if (songs.length !== 100) throw new Error(`預期 100 首，實際 ${songs.length} 首`);
if (new Set(songs.map(song => song[2])).size !== songs.length) throw new Error('清單內有重複 YouTube ID');

const db = new DatabaseSync(databasePath);
const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const backupPath = path.join(root, 'data', `ktv-before-popular-100-${stamp}.sqlite`);
db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);

const exists = db.prepare('SELECT id FROM seen WHERE video_id=?');
const insert = db.prepare('INSERT INTO seen(title,youtube_url,video_id) VALUES(?,?,?)');
let added = 0;
let skipped = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const [title, artist, videoId] of songs) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error(`YouTube ID 格式錯誤：${title}`);
    if (exists.get(videoId)) {
      skipped += 1;
      continue;
    }
    insert.run(`${title}－原唱`, `https://www.youtube.com/watch?v=${videoId}`, videoId);
    added += 1;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}

console.log(JSON.stringify({ requested: songs.length, added, skipped, backupPath }, null, 2));
