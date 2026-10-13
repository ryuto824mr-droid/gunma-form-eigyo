// lib/greeting-name.js
//
// メール・フォームの文面の {{company_name}}(宛名)に入れる企業名を決める。
// 以前は「正式名称(会社概要から取った名前)、無ければ登録名」をそのまま入れていたため、
// 「株式会社は損害保険 ご担当者様」(正式名称の取り出しの誤り)や、検索結果のページのタイトル
// (「群馬県のおすすめシステム開発会社12選【2024年最新版】|…」)がそのまま宛名になっていた
// (2026-10: アーカイブ済みを除く177社、うち38社は送信済み)。
// 宛名として使える名前が無いときは名前を入れず、件名・本文を次のように置き換える:
//   件名「{{company_name}} 様|…」→「…」 / 本文「{{company_name}} ご担当者様」→「ご担当者様」 / それ以外 →「貴社」

const LEGAL_RE = "(株式会社|有限会社|合同会社|合資会社|㈱|㈲)";
const BARE_LEGAL_RE = new RegExp(`^${LEGAL_RE}$`);
const LEGAL_THEN_PARTICLE_RE = new RegExp(`^${LEGAL_RE}(は|が|を|の|に|で|と|へ|も|や|から|より)`);
// 区切り記号(ページのタイトルの「会社名 | ページ名」「会社名: HOME」等)
const DELIMITER_RE = /[｜|【】「」『』\[\]<>《》:：]/;
// ページ名・一般語(検索結果のタイトルやサイトの説明文に使われる語)
const PAGE_WORD_RE = /(公式|ホームページ|トップページ|会社概要|会社案内|企業情報|会社情報|評判|口コミ|クチコミ|検索|おすすめ|オススメ|ランキング|一覧|について|まとめ|比較|最新|導入事例|プレスリリース|アーカイブ|お探し|探す|ガイド|ウェブサイト|サイト)/;
// 「〇〇なら△△」「〇〇は△△」のような説明文(前後が漢字・カタカナ・英字のときだけ)
const DESCRIPTION_RE = /[一-龠ァ-ヶA-Za-z0-9](なら|は|を)[一-龠ァ-ヶA-Za-z]/;
// 地域の説明から始まる(「群馬県太田市の不動産」「藤岡市の…」)
const REGION_PREFIX_RE = /^(群馬県)?[一-龠]{1,4}[市町村]の/;
const SENTENCE_END_RE = /(する|します|です|ます|ください|しています|できる|の紹介)$/;
const GENERIC_ONLY_RE = /^(system|home|top|法人番号|会社概要|会社案内|企業情報|会社情報|トップページ|事業所・工場)$/i;

const MIN_LEN = 2;
const MAX_LEN = 25;

// 宛名として使ってよい名前か。戻り値: { ok, reason }
function checkGreetingName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, reason: "名前が空" };
  if (name.length < MIN_LEN) return { ok: false, reason: "短すぎる" };
  if (name.length > MAX_LEN) return { ok: false, reason: `長すぎる(${name.length}字)` };
  if (BARE_LEGAL_RE.test(name)) return { ok: false, reason: "法人格だけ" };
  if (LEGAL_THEN_PARTICLE_RE.test(name)) return { ok: false, reason: "法人格の直後が助詞" };
  if (DELIMITER_RE.test(name)) return { ok: false, reason: "区切り記号を含む(ページのタイトル)" };
  if (GENERIC_ONLY_RE.test(name)) return { ok: false, reason: "一般語だけ" };
  // 法人格を除いて判定する(「株式会社情報通信総合研究所」の「株式会社情報」を「会社情報」と取り違えないため)
  if (PAGE_WORD_RE.test(name.replace(new RegExp(LEGAL_RE, "g"), " "))) return { ok: false, reason: "ページ名・一般語を含む" };
  if (SENTENCE_END_RE.test(name) || /[。！？!?]/.test(name)) return { ok: false, reason: "文の形" };
  if (REGION_PREFIX_RE.test(name)) return { ok: false, reason: "地域の説明から始まる" };
  if (DESCRIPTION_RE.test(name)) return { ok: false, reason: "説明文の形(〜なら・〜は)" };
  return { ok: true, reason: null };
}

// 宛名に使う名前。正式名称 → 登録名の順に判定し、使える方を返す。
// 戻り値: { name(使えなければ null), source("official"|"name"|null), rejected: [{ value, reason }] }
function resolveGreetingName(company) {
  const rejected = [];
  const candidates = [
    ["official", company && company.company_info && company.company_info.official_name],
    ["name", company && company.name],
  ];
  for (const [source, value] of candidates) {
    if (!value) continue;
    const check = checkGreetingName(value);
    if (check.ok) return { name: String(value).replace(/\s+/g, " ").trim(), source, rejected };
    rejected.push({ value: String(value), reason: check.reason });
  }
  return { name: null, source: null, rejected };
}

// テンプレートの {{company_name}} を置き換える。kind: "subject"(件名)| "body"(本文)
function fillCompanyName(template, company, kind) {
  const text = template || "";
  const { name } = resolveGreetingName(company);
  if (name) return text.replace(/\{\{company_name\}\}/g, name);
  let out = text;
  if (kind === "subject") {
    // 「{{company_name}} 様|群馬の…」→「群馬の…」
    out = out.replace(/\{\{company_name\}\}\s*様\s*[｜|:：\-ー―]?\s*/g, "");
  }
  // 「{{company_name}} ご担当者様」→「ご担当者様」
  out = out.replace(/\{\{company_name\}\}\s*(ご担当者様)/g, "$1");
  // それ以外 →「貴社」
  return out.replace(/\{\{company_name\}\}/g, "貴社");
}

module.exports = { checkGreetingName, resolveGreetingName, fillCompanyName };
