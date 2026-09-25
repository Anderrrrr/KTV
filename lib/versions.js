// 原唱／伴唱: a song can be linked to its other version (the vocal original or the karaoke
// backing track), so the singer can switch mid-song. These helpers read the version from a title.
import { lyricsQueries } from './external.js';

const KARAOKE = /(純伴奏|伴奏|伴唱|卡拉\s*OK|karaoke|instrumental|off\s*vocal|KTV)/i;
const VOCAL = /(原唱|導唱|官方|MV|official)/i;

// 'karaoke', 'vocal', or null when the title doesn't say.
export function versionKind(title) {
  if (KARAOKE.test(title)) return 'karaoke';
  if (VOCAL.test(title)) return 'vocal';
  return null;
}

// "我懷念的－純伴奏" and "我懷念的－原唱" share the base "我懷念的".
export function baseTitle(title) {
  return title.replace(/\s*[－—–-]\s*(原唱|純伴奏|伴奏|伴唱|導唱|KTV|卡拉\s*OK|karaoke)\s*$/i, '').trim();
}

// What the other version is, and how to search YouTube for it. Unlabelled titles are
// usually music videos (with vocals), so their partner is the karaoke version.
export function partnerPlan(title) {
  const kind = versionKind(title) ?? 'vocal';
  const partnerKind = kind === 'vocal' ? 'karaoke' : 'vocal';
  const name = lyricsQueries(title)[0] || baseTitle(title);
  return {
    kind,
    partnerKind,
    searchQuery: `${name} ${partnerKind === 'vocal' ? '原唱' : '伴奏'}`,
    partnerTitle: `${baseTitle(title)}－${partnerKind === 'vocal' ? '原唱' : '純伴奏'}`
  };
}
