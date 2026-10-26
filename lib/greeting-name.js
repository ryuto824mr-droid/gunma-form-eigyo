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
// 区切り記号(ページのタイトルの「会社名 | ページ名」「会社名: HOME」等)。
// 罫線の縦線(「プロタイムズ渋川店┃有限会社カナイ建装工業」: 2387)も区切りとして扱う
const DELIMITER_RE = /[｜|┃│【】「」『』\[\]<>《》:：]/;
// ページ名・一般語(検索結果のタイトルやサイトの説明文に使われる語)
const PAGE_WORD_RE = /(公式|ホームページ|トップページ|会社概要|会社案内|企業情報|会社情報|評判|口コミ|クチコミ|検索|おすすめ|オススメ|ランキング|一覧|について|まとめ|比較|最新|導入事例|プレスリリース|アーカイブ|お探し|探す|ガイド|ウェブサイト|サイト)/;
// 「〇〇なら△△」「〇〇は△△」のような説明文(前後が漢字・カタカナ・英字のときだけ)
const DESCRIPTION_RE = /[一-龠ァ-ヶA-Za-z0-9](なら|は|を)[一-龠ァ-ヶA-Za-z]/;
// ひらがなの語のあとの「は」で始まる説明文(「しゅんせつはみなしろ建設株式会社」= 浚渫は〇〇建設)。
// 上の DESCRIPTION_RE は「は」の前が漢字・カナ・英字のときしか見ないため、別に判定する。
// 社名にもある「このはな」「たかはし」(ひらがな2文字以下 + は)と、「〜はうす」「〜はーと」「〜はら」「〜はま」
// 「〜はし」「〜はた」「〜はや」「〜はぎ」(はうす=ハウス、原・浜・橋・畑・林・萩)は社名の一部とみなして除く。
// 「は」のあとに漢字・カナ・英字があるときだけ(ひらがなだけが続く社名は対象外)。語には伸ばし棒(りふぉーむ)も含める
const HIRAGANA_TOPIC_RE = /[ぁ-ゖー]{3,}は(?!うす|ーと|ら|ま|し|た|や|ぎ)(?=.*[一-龠ァ-ヶA-Za-zＡ-Ｚａ-ｚ])/;
// 地域の説明から始まる(「群馬県太田市の不動産」「藤岡市の…」)
const REGION_PREFIX_RE = /^(群馬県)?[一-龠]{1,4}[市町村]の/;
const SENTENCE_END_RE = /(する|します|です|ます|ください|しています|できる|の紹介)$/;
const GENERIC_ONLY_RE = /^(system|home|top|法人番号|会社概要|会社案内|企業情報|会社情報|トップページ|事業所・工場)$/i;

// 法人格の略記((株)・（有）等)。括弧の判定ではこれを括弧として数えない
const LEGAL_ABBR_RE = /[(（](株|有|合|資)[)）]/g;
// 括弧つき(「池田製作所（群馬県太田市）」「Farmdo（ファームドゥ）」)。略記の(株)等は除いてから見る
const PAREN_RE = /[(（)）]/;
// 事業の説明が頭に付いている(「樹脂加工の植木プラスチック株式会社」)
const BUSINESS_PREFIX_RE = /^\S{0,10}(加工|製造|販売|工事|不動産|建設|開発|専門|製作|設計|印刷|塗装|修理|リフォーム|運送|物流|メーカー|専門店)の/;
// 事業所の名前が後ろに付いている(「株式会社阿部製作 本社」「（株）冨士ハム伊勢崎工場」)
const OFFICE_SUFFIX_RE = /(本社|本店|支店|支社|営業所|出張所|事業所|工場)$/;
// 法人格のある名前の末尾に助詞「へ」が付いている(「株式会社杜丸不動産へ」: 「〜へのお問い合わせ」の
// 「の」から後ろが切れた形)。「へ」の前がひらがなの社名(「株式会社みらいへ」のような名前)は除く
const TRAILING_HE_RE = /[一-龠々ァ-ヶーA-Za-z0-9Ａ-Ｚａ-ｚ０-９)）]へ$/;
// 法人格 + 1文字だけ(「株式会社G」: 「株式会社G・Mフーズ」が中黒で切れた形)
const LEGAL_PLUS_ONE_RE = new RegExp("^(" + LEGAL_RE + "\\s?\\S|\\S\\s?" + LEGAL_RE + ")$");
// 法人格 + 英字1文字の読みだけ(「エー株式会社」: 「セルフ・エー株式会社」が中黒で切れた形(2385)、
// 「ケイ株式会社」「株式会社シー」も同じ)
const LETTER_KANA_RE = "(エー|エイ|ビー|シー|ディー|イー|エフ|ジー|エイチ|アイ|ジェイ|ジェー|ケイ|ケー|エル|エム|エヌ|オー|ピー|キュー|アール|エス|ティー|ユー|ブイ|ヴィ|ダブリュー|エックス|ワイ|ゼット|ゼッド)";
const LEGAL_PLUS_LETTER_KANA_RE = new RegExp("^(" + LEGAL_RE + "\\s?" + LETTER_KANA_RE + "|" + LETTER_KANA_RE + "\\s?" + LEGAL_RE + ")$");
const LETTER_KANA_REASON = "法人格と英字1文字の読みだけ(途中で切れた疑い)";
// 中黒・点など、名前の途中に入る区切り(この直前で切れた名前を見つけるのに使う)
const MIDDLE_DOT_RE = /^[・･·•．.＆&]/;

// 空白をはさんだダッシュ(「たかまえ病院 - 群馬県高崎市」「トップ - 髙橋建設株式会社」: ページのタイトルの区切り)。
// 名前の末尾のダッシュ(「株式会社長野フィナンシャル -」)と、語の直後のダッシュ+空白(「三幸機械株式会社- 大型部品加工」)も含める
const SPACED_DASH_RE = /\s[-－–—―]\s|[-－–—―]\s*$|\S[-－–—―]\s/;
// 「橙 -Dai Dai-」のように、ダッシュで読みや副題を囲んだ名前は区切りとみなさない
const DASH_ENCLOSED_RE = /\s[-－–—―][^-－–—―\s][^-－–—―]*[-－–—―]$/;
// 法人格のある名前の後ろに、空白をはさんで事業所・部署の名前や地名が付いている
// (「渡辺パイプ（株） 伊勢崎サービスセンター」「（株）群馬丸魚 営業本部」「日本不動産株式会社 群馬県高崎市」)。
// 空白で区切った最後の語だけを見る(「株式会社農業支援センター」のように社名の一部の「センター」は対象外)
const TRAILING_OFFICE_WORD_RE = /(センター|本部|営業部|事業部|総務課|部|課|オフィス|製造所|教習所|事務所|倉庫|出張所|営業所|支店|支社|本社|本店|工場|店)$/;
const TRAILING_PLACE_WORD_RE = /^(群馬県[一-龠ヶ]*|[一-龠ヶ]{1,4}(市|町|村))$/;
function trailingSegmentProblem(name) {
  const segs = name.split(" ");
  if (segs.length < 2) return null;
  const last = segs[segs.length - 1];
  const head = segs.slice(0, -1).join(" ");
  const hasLegal = (s) => new RegExp(LEGAL_RE).test(s) || new RegExp(LEGAL_ABBR_RE.source).test(s);
  if (!hasLegal(head) || hasLegal(last)) return null;
  if (TRAILING_PLACE_WORD_RE.test(last)) return "社名の後ろに地名が付いている";
  if (TRAILING_OFFICE_WORD_RE.test(last)) return "社名の後ろに事業所・部署の名前が付いている";
  return null;
}

const MIN_LEN = 2;
const MAX_LEN = 25;

// 宛名として使ってよい名前か。戻り値: { ok, reason }
function checkGreetingName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, reason: "名前が空" };
  if (name.length < MIN_LEN) return { ok: false, reason: "短すぎる" };
  if (name.length > MAX_LEN) return { ok: false, reason: `長すぎる(${name.length}字)` };
  if (BARE_LEGAL_RE.test(name)) return { ok: false, reason: "法人格だけ" };
  if (LEGAL_PLUS_ONE_RE.test(name)) return { ok: false, reason: "法人格と1文字だけ(途中で切れた疑い)" };
  if (LEGAL_PLUS_LETTER_KANA_RE.test(name)) return { ok: false, reason: LETTER_KANA_REASON };
  if (LEGAL_THEN_PARTICLE_RE.test(name)) return { ok: false, reason: "法人格の直後が助詞" };
  if ((new RegExp(LEGAL_RE).test(name) || new RegExp(LEGAL_ABBR_RE.source).test(name)) && TRAILING_HE_RE.test(name)) return { ok: false, reason: "末尾が助詞「へ」(〜へのお問い合わせ等が切れた形)" };
  if (DELIMITER_RE.test(name)) return { ok: false, reason: "区切り記号を含む(ページのタイトル)" };
  if (SPACED_DASH_RE.test(name) && !DASH_ENCLOSED_RE.test(name)) return { ok: false, reason: "空白をはさんだダッシュを含む(ページのタイトル)" };
  if (GENERIC_ONLY_RE.test(name)) return { ok: false, reason: "一般語だけ" };
  // 法人格を除いて判定する(「株式会社情報通信総合研究所」の「株式会社情報」を「会社情報」と取り違えないため)
  if (PAGE_WORD_RE.test(name.replace(new RegExp(LEGAL_RE, "g"), " "))) return { ok: false, reason: "ページ名・一般語を含む" };
  if (SENTENCE_END_RE.test(name) || /[。！？!?]/.test(name)) return { ok: false, reason: "文の形" };
  if (REGION_PREFIX_RE.test(name)) return { ok: false, reason: "地域の説明から始まる" };
  if (DESCRIPTION_RE.test(name)) return { ok: false, reason: "説明文の形(〜なら・〜は)" };
  if (HIRAGANA_TOPIC_RE.test(name)) return { ok: false, reason: "説明文の形(ひらがなの語＋は)" };
  if (PAREN_RE.test(name.replace(LEGAL_ABBR_RE, ""))) return { ok: false, reason: "括弧つき" };
  if (BUSINESS_PREFIX_RE.test(name)) return { ok: false, reason: "事業の説明が頭に付いている" };
  if (OFFICE_SUFFIX_RE.test(name)) return { ok: false, reason: "本社・工場などの事業所名が付いている" };
  const trailing = trailingSegmentProblem(name);
  if (trailing) return { ok: false, reason: trailing };
  return { ok: true, reason: null };
}

// 比べるための形(法人格の略記をそろえ、空白を除く)
function normalizeForCompare(value) {
  return String(value || "")
    .replace(/㈱|[(（]株[)）]/g, "株式会社")
    .replace(/㈲|[(（]有[)）]/g, "有限会社")
    .replace(/\s+/g, "");
}

// 正式名称が、登録名の途中(中黒などの直前)で切れた形か。
// 例: 正式名称「株式会社ティー」・登録名「㈱ティー･エス･ケー 本社工場」 → 「･」の直前で切れている
function truncatedAgainst(official, other) {
  const a = normalizeForCompare(official);
  const b = normalizeForCompare(other);
  if (!a || !b || a === b) return false;
  for (let i = b.indexOf(a); i >= 0; i = b.indexOf(a, i + 1)) {
    if (MIDDLE_DOT_RE.test(b.slice(i + a.length))) return true;
  }
  return false;
}

// 正式名称の頭が欠けた形か(正式名称が登録名の途中から始まり、その直前が社名の続きになっている)。
// 例: 正式名称「SHOWA株式会社」・登録名「MYK SHOWA株式会社」(2378)、「木商事株式会社」・「佐々木商事株式会社」(2062)、
// 「ロジスティクス株式会社」・「リス・ロジスティクス株式会社」(2477)。
// 直前の文字が英数字・カナ・漢字・中黒・点で、空白をはさまないときだけ(英字どうしは空白1つもよい)。
// 「群馬県太田市の興伸化成株式会社」「仮設足場工事 株式会社スーパーエンジニアリング」のように、
// 説明の後ろに助詞や空白をはさんで社名が続く形は欠けとみなさない(正式名称のほうが正しい)
function headTruncatedAgainst(official, other) {
  const norm = (s) => String(s || "").normalize("NFKC").replace(new RegExp(LEGAL_RE, "g"), " ")
    .replace(/[(（](株|有|合|資)[)）]/g, " ").replace(/\s+/g, " ").trim();
  const o = norm(official);
  const n = norm(other);
  if (o.length < 2 || !n || o === n) return false;
  const i = n.indexOf(o);
  if (i <= 0) return false;
  const before = n.slice(0, i);
  if (/[A-Za-z0-9ァ-ヶー一-龠々・･·.&]$/.test(before)) return true;
  return / $/.test(before) && /[A-Za-z0-9]$/.test(before.slice(0, -1)) && /^[A-Za-z0-9]/.test(o);
}

// 正式名称が登録名に、前後に社名の続きの無い形でそのまま載っているか(「Q co.,ltd.【株式会社キュー】」の「株式会社キュー」)
function appearsWholeIn(official, other) {
  const a = normalizeForCompare(official);
  const b = normalizeForCompare(other);
  if (!a || !b) return false;
  const CONT = /[A-Za-z0-9Ａ-Ｚａ-ｚ０-９ァ-ヶーぁ-ゖ一-龠々・･·.．&＆]/;
  for (let i = b.indexOf(a); i >= 0; i = b.indexOf(a, i + 1)) {
    const before = b[i - 1];
    const after = b[i + a.length];
    if (!(before && CONT.test(before)) && !(after && CONT.test(after))) return true;
  }
  return false;
}

// 英数字・記号だけの登録名(「Otakankosabisu」「Benriya At Home Service」: 地図の検索から英語・ローマ字の表記の
// まま登録された名前)。宛名には使わず「ご担当者様」で送る。名前が崩れているのではないので、宛名が不確か
// (送信待ちに入れられない)とはしない。正式名称が英数字だけのとき(UNIGRAD 等)は、サイトから取った社名なので使う
const ASCII_ONLY_RE = /^[\x20-\x7E]+$/;
const ASCII_NAME_REASON = "登録名が英数字だけ(英語・ローマ字の表記)。「ご担当者様」で送る";

// 宛名に使う名前。正式名称 → 登録名の順に判定し、使える方を返す。
// 戻り値: { name(使えなければ null), source("official"|"name"|null), rejected: [{ value, reason }],
//          fallbackOk(名前が無くても「ご担当者様」で送ってよいとき true) }
function resolveGreetingName(company) {
  const rejected = [];
  let fallbackOk = false;
  const candidates = [
    ["official", company && company.company_info && company.company_info.official_name],
    ["name", company && company.name],
  ];
  for (const [source, value] of candidates) {
    if (!value) continue;
    if (source === "name" && ASCII_ONLY_RE.test(String(value).trim())) {
      rejected.push({ value: String(value), reason: ASCII_NAME_REASON });
      fallbackOk = true;
      continue;
    }
    let check = checkGreetingName(value);
    // 「株式会社キュー」(919 登録名「Q co.,ltd.【株式会社キュー】」)のように、英字1文字の読みだけの正式名称でも、
    // 登録名に前後の続きの無い形でそのまま載っていれば本当の社名とみなして使う
    if (!check.ok && check.reason === LETTER_KANA_REASON && source === "official" && appearsWholeIn(value, company && company.name)) {
      check = { ok: true, reason: null };
    }
    if (!check.ok) {
      rejected.push({ value: String(value), reason: check.reason });
      continue;
    }
    // 名前の形は良くても、正式名称が登録名の途中で切れた形なら使わない(「株式会社ティー」と「㈱ティー･エス･ケー」)
    if (source === "official" && truncatedAgainst(value, company && company.name)) {
      rejected.push({ value: String(value), reason: "途中で切れている(登録名では中黒などが続く)" });
      continue;
    }
    // 正式名称の頭が欠けた形も使わない(「SHOWA株式会社」と「MYK SHOWA株式会社」)
    if (source === "official" && headTruncatedAgainst(value, company && company.name)) {
      rejected.push({ value: String(value), reason: "頭が欠けている(登録名では前に続きがある)" });
      continue;
    }
    return { name: String(value).replace(/\s+/g, " ").trim(), source, rejected, fallbackOk: false };
  }
  return { name: null, source: null, rejected, fallbackOk };
}

// 宛名が不確か(名前が無く、「ご担当者様」で送ってよいとも言えない)か。保留・送信待ちへの追加、★候補の判定、
// 「あとで送る」の警告で使う
function isGreetingUncertain(company) {
  const g = resolveGreetingName(company);
  return !g.name && !g.fallbackOk;
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

module.exports = { checkGreetingName, resolveGreetingName, isGreetingUncertain, fillCompanyName, truncatedAgainst, headTruncatedAgainst };
