// lib/prefecture.js
//
// 住所の文字から都道府県を見分け、営業の対象の県(群馬県)の会社かどうかを判定する。
// 企業探しで群馬以外の同じ名前の町村(三重県明和町・長野県南牧村・長野県高山村・福島県昭和村・滋賀県草津市)の
// 会社やページを拾っていた(2026-10: locle の 184社のうち6社が県外、4社が同名の町村の取り違え)ため、
//   - Google Places の結果(formattedAddress)
//   - リサーチの会社概要から取り出した住所(lib/company-info-extractor.js)
// の両方で使う。DB・ブラウザ・外部APIは使わない純粋な関数。

const TARGET_PREFECTURE = "群馬県";

const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
  "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
  "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];
const PREFECTURE_RE = new RegExp(`(${PREFECTURES.join("|")})`);

// 文字の中で最初に出てくる都道府県名(無ければ null)
function prefectureOf(text) {
  const m = PREFECTURE_RE.exec(String(text || ""));
  return m ? m[1] : null;
}

// 住所の見出し(表の「所在地」「本社所在地」「住所」「工場」等)と、郵便番号(〒370-0000 / 〒3700000)
const ADDRESS_MARK_RE = /(本社所在地|本店所在地|本社住所|所在地|住所|本社|本店|工場|事業所|営業所|Address|〒\s?[0-9０-９]{3}[-－‐ー]?[0-9０-９]{4})/g;
// 見出しと都道府県名の間に入ってよい文字(空白・コロン・郵便番号)。「群馬県知事より表彰」のような文の中の
// 県名や、見出しから離れた県名を住所と取り違えないため、これ以外の文字が挟まる場合は住所とみなさない
const GAP_RE = /^[\s　:：・\-－‐ー〒0-9０-９]{0,20}$/;

// 文字の中の住所をすべて取り出す。戻り値: [{ address, prefecture }](見つかった順・重複なし)
// 都道府県名の無い住所(「前橋市大手町1-1」だけ等)は判定できないため含めない
function extractAddresses(text) {
  const t = String(text || "");
  const found = [];
  const seen = new Set();
  ADDRESS_MARK_RE.lastIndex = 0;
  let m;
  while ((m = ADDRESS_MARK_RE.exec(t)) !== null) {
    const start = m.index + m[0].length;
    const window = t.slice(start, start + 40);
    const p = PREFECTURE_RE.exec(window);
    if (!p || !GAP_RE.test(window.slice(0, p.index))) continue;
    const lineStart = start + p.index;
    const line = t.slice(lineStart, lineStart + 80).split("\n")[0].trim().slice(0, 80);
    if (seen.has(line)) continue;
    seen.add(line);
    found.push({ address: line, prefecture: p[1] });
  }
  return found;
}

// 会社概要の住所を1つ選ぶ。戻り値: { address, prefecture } または null
// 本社が県外でも、群馬県内の工場・事業所の住所が載っていれば、その住所を選ぶ
// (冨士ハム: 本社 東京都品川区・群馬の工場、日本製線: 本社 東京都港区・前橋工場 のような会社を県外とみなさない)
// target: 優先する県(文字列か配列。lib/area.js の preferredPrefectures)。空の配列なら最初の住所
function extractAddress(text, target = TARGET_PREFECTURE) {
  const all = extractAddresses(text);
  const preferred = Array.isArray(target) ? target : [target];
  return all.find((a) => preferred.includes(a.prefecture)) || all[0] || null;
}

// 会社概要(company_info)の住所の県が営業の対象の県でなければ、自動送信不可にする理由を返す(対象の県・不明なら null)
function prefectureBlockReason(companyInfo, target = TARGET_PREFECTURE) {
  const pref = companyInfo && companyInfo.prefecture;
  if (!pref || pref === target) return null;
  return `会社概要の住所が${target}ではない(${pref}${companyInfo.address ? `: ${String(companyInfo.address).slice(0, 40)}` : ""})`;
}

module.exports = { TARGET_PREFECTURE, PREFECTURES, prefectureOf, extractAddress, extractAddresses, prefectureBlockReason };
