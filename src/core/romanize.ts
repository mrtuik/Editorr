/**
 * Offline romanizer: Bengali script -> Banglish, Devanagari (Hindi) -> Hinglish.
 * Rule based and phonetic, so the spelling is "how it sounds", not a fixed standard. Other characters pass through.
 */
interface Piece { s: string; schwa: boolean; vowel: boolean }

const BN_CONS: Record<string, string> = {
  'ক': 'k', 'খ': 'kh', 'গ': 'g', 'ঘ': 'gh', 'ঙ': 'ng', 'চ': 'ch', 'ছ': 'chh', 'জ': 'j', 'ঝ': 'jh', 'ঞ': 'n',
  'ট': 't', 'ঠ': 'th', 'ড': 'd', 'ঢ': 'dh', 'ণ': 'n', 'ত': 't', 'থ': 'th', 'দ': 'd', 'ধ': 'dh', 'ন': 'n',
  'প': 'p', 'ফ': 'ph', 'ব': 'b', 'ভ': 'bh', 'ম': 'm', 'য': 'j', 'র': 'r', 'ল': 'l', 'শ': 'sh', 'ষ': 'sh',
  'স': 's', 'হ': 'h', 'ড়': 'r', 'ঢ়': 'rh', 'য়': 'y', 'ৎ': 't',
};
const BN_VOW: Record<string, string> = { 'অ': 'o', 'আ': 'a', 'ই': 'i', 'ঈ': 'i', 'উ': 'u', 'ঊ': 'u', 'ঋ': 'ri', 'এ': 'e', 'ঐ': 'oi', 'ও': 'o', 'ঔ': 'ou' };
const BN_MATRA: Record<string, string> = { 'া': 'a', 'ি': 'i', 'ী': 'i', 'ু': 'u', 'ূ': 'u', 'ৃ': 'ri', 'ে': 'e', 'ৈ': 'oi', 'ো': 'o', 'ৌ': 'ou' };
const BN_DIGIT = '০১২৩৪৫৬৭৮৯';

const HI_CONS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh',
  'स': 's', 'ह': 'h', 'ळ': 'l', 'क्ष': 'ksh', 'ज्ञ': 'gy',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
};
const HI_VOW: Record<string, string> = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o' };
const HI_MATRA: Record<string, string> = { 'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॆ': 'e', 'ॊ': 'o' };
const HI_DIGIT = '०१२३४५६७८९';

interface Script {
  cons: Record<string, string>; vow: Record<string, string>; matra: Record<string, string>;
  virama: string; nukta: string; nasal: Record<string, string>; digits: string; schwa: string; hindi: boolean;
  range: RegExp;
}
const BN: Script = { cons: BN_CONS, vow: BN_VOW, matra: BN_MATRA, virama: '্', nukta: '়', nasal: { 'ং': 'ng', 'ঃ': 'h', 'ঁ': 'n' }, digits: BN_DIGIT, schwa: 'o', hindi: false, range: /[\u0980-\u09FF]/ };
const HI: Script = { cons: HI_CONS, vow: HI_VOW, matra: HI_MATRA, virama: '्', nukta: '़', nasal: { 'ं': 'n', 'ः': 'h', 'ँ': 'n' }, digits: HI_DIGIT, schwa: 'a', hindi: true, range: /[\u0900-\u097F]/ };

function word(w: string, sc: Script): string {
  const chars = Array.from(w);
  const pieces: Piece[] = [];
  const tail = (s: string) => { if (pieces.length) pieces[pieces.length - 1].s += s; else pieces.push({ s, schwa: false, vowel: true }); };
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i];
    if (chars[i + 1] === sc.nukta) { c = c + sc.nukta; i++; }
    if (c === '\u200d' || c === '\u200c') continue;
    if (sc.hindi && (c === 'क' || c === 'ज') && chars[i + 1] === sc.virama && (chars[i + 2] === 'ष' || chars[i + 2] === 'ञ')) { c = c + sc.virama + chars[i + 2]; i += 2; }
    const cons = sc.cons[c] ?? sc.cons[c.normalize('NFC')];
    if (cons !== undefined) {
      const nx = chars[i + 1];
      if (nx === sc.virama) { pieces.push({ s: cons, schwa: false, vowel: false }); i++; }
      else if (nx !== undefined && sc.matra[nx] !== undefined) { pieces.push({ s: cons + sc.matra[nx], schwa: false, vowel: true }); i++; }
      else pieces.push({ s: cons, schwa: true, vowel: true });
      continue;
    }
    if (sc.vow[c] !== undefined) { pieces.push({ s: sc.vow[c], schwa: false, vowel: true }); continue; }
    if (sc.matra[c] !== undefined) { tail(sc.matra[c]); continue; }
    if (sc.nasal[c] !== undefined) { tail(sc.nasal[c]); continue; }
    const d = sc.digits.indexOf(c);
    if (d >= 0) { pieces.push({ s: String(d), schwa: false, vowel: false }); continue; }
    pieces.push({ s: c, schwa: false, vowel: false });
  }
  // inherent vowel: always dropped at the end of a word
  const last = pieces.length - 1;
  if (last >= 0 && pieces[last].schwa) pieces[last].schwa = false, pieces[last].vowel = false;
  // Hindi also drops it inside the word (VC_CV), right to left
  if (sc.hindi) {
    for (let i = pieces.length - 2; i >= 1; i--) {
      if (pieces[i].schwa && pieces[i - 1].vowel && pieces[i + 1].vowel) { pieces[i].schwa = false; pieces[i].vowel = false; }
    }
  }
  return pieces.map((x) => x.s + (x.schwa ? sc.schwa : '')).join('');
}

/** Convert text in Bengali or Devanagari script to Latin letters. Text in other scripts is returned unchanged. */
export function romanize(text: string): string {
  const sc = BN.range.test(text) ? BN : HI.range.test(text) ? HI : null;
  if (!sc) return text;
  return text.split(/(\s+)/).map((part) => (sc.range.test(part) ? word(part, sc) : part)).join('');
}

/** True when the text uses a script this file can romanize. */
export function needsRoman(text: string): boolean { return BN.range.test(text) || HI.range.test(text); }
