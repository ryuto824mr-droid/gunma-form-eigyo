// lib/email-extract.js
//
// ページからメールアドレスの候補を集める。リサーチ(lib/form-analyzer.js)の問い合わせページと、
// 会社概要の取得(lib/company-info-extractor.js)で開くトップページ(フッターを含む)・会社概要ページの
// 両方で使う。以前は問い合わせページでしか探しておらず、トップや会社概要に書かれたアドレスを拾えなかった。
//
// ブラウザでは mailto: リンクとページの文字だけを集め(collectEmailSourcesInBrowser)、
// 難読化の正規化と抽出は Node 側で行う(findEmailsInText。テストしやすくするため)。

const { sameCompanyDomain } = require("./domain-utils");

// page.evaluate に渡すため、外部の変数・関数を参照しない自己完結した関数にしておく
function collectEmailSourcesInBrowser() {
  const mailtos = [];
  document.querySelectorAll('a[href^="mailto:" i]').forEach((a) => {
    const addr = (a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0].trim();
    if (addr) mailtos.push(addr);
  });
  return { mailtos, text: (document.body && document.body.innerText) || "" };
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// 「@」「.」を別の表記に置き換えて難読化したアドレスを、通常の表記に直した文字列の一覧。
// 直した後に正規のアドレスの形に一致したものだけを採るため、無関係な語を誤って拾うおそれは低い
function normalizedVariants(text) {
  const t = String(text || "");
  const variants = [t];
  // "info[アットマーク]example.com" "info（アットマーク）example.com" "info アットマーク example.com"
  variants.push(t.replace(/[\(（\[［]\s*アットマーク\s*[\)）\]］]/g, "@").replace(/\s*アットマーク\s*/g, "@"));
  // "info＠example.com"(全角)
  variants.push(t.replace(/＠/g, "@"));
  // "info(at)example.com" "info[at]example.com" "info（あっと）example.com" "info[@]example.com"
  variants.push(t.replace(/[\(（\[［]\s*(at|あっと|アット|@|＠)\s*[\)）\]］]/gi, "@"));
  // "infoアットexample.com"(括弧なしの「アット」)
  variants.push(t.replace(/アット/g, "@"));
  // "info★example.com" "info☆example.com" "info◎example.com"(記号を@の代わりにする表記)
  variants.push(t.replace(/([a-zA-Z0-9._%+-])\s*[★☆◎●◆]\s*([a-zA-Z0-9-])/g, "$1@$2"));
  // "info @ example.com"(@の前後に空白)
  variants.push(t.replace(/([a-zA-Z0-9._%+-])\s+[@＠]\s+([a-zA-Z0-9-])/g, "$1@$2"));
  // ドットの難読化: "[dot]" "(dot)" "（ドット）" と全角の「．」。上の各表記と組み合わせても直す
  const dotFixed = variants.map((v) => v
    .replace(/\s*[\(（\[［]\s*(dot|ドット|どっと)\s*[\)）\]］]\s*/gi, ".")
    .replace(/([a-zA-Z0-9-])．([a-zA-Z0-9-])/g, "$1.$2"));
  return [...variants, ...dotFixed];
}

// 文字からメールアドレスの候補を集める(重複なし・見つかった順)
function findEmailsInText(text) {
  const found = new Set();
  for (const v of normalizedVariants(text)) {
    (v.match(EMAIL_RE) || []).forEach((m) => found.add(m));
  }
  // "info at example dot com"(英語のスペース区切り表記)
  const atDotRe = /\b([a-zA-Z0-9._%+-]+)\s+at\s+([a-zA-Z0-9-]+(?:\s+dot\s+[a-zA-Z0-9-]+)+)\b/gi;
  let m;
  while ((m = atDotRe.exec(String(text || ""))) !== null) {
    found.add(`${m[1]}@${m[2].replace(/\s+dot\s+/gi, ".")}`);
  }
  return Array.from(found);
}

// 見えない文字(ゼロ幅スペース等)・改行などの制御文字・空白
// (文字コードの範囲で判定する。ソースに見えない文字そのものを書かないため)
const INVISIBLE_RANGES = [[0x00, 0x1f], [0x7f, 0x7f], [0xa0, 0xa0], [0x200b, 0x200f], [0x2028, 0x2029], [0x2060, 0x2060], [0xfeff, 0xfeff]];
const isInvisibleChar = (ch) => {
  const code = ch.codePointAt(0);
  return /\s/.test(ch) || INVISIBLE_RANGES.some(([a, b]) => code >= a && code <= b);
};
const removeInvisible = (s) => Array.from(s).filter((ch) => !isInvisibleChar(ch)).join("");
const MAILTO_EMAIL_RE = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

// mailto: のリンクのアドレスを、送れる形に直す(直せなければ null)。
// 以前は mailto: のアドレスを形を確かめずに候補に入れていたため、サイトのひな形の伏せ字
// 「info@○○○○○○○.co.jp」(1805)・URLの符号と改行の残った「info@noguch%69f\n.com」(1817)・
// 先頭に見えない文字の付いた「(U+200B)info@mysite.co.jp」(1219)がそのまま登録されていた
function cleanMailtoAddress(raw) {
  let addr = String(raw || "");
  try {
    addr = decodeURIComponent(addr);
  } catch {
    // 符号が壊れている場合はそのまま形を確かめる(下で弾かれる)
  }
  addr = removeInvisible(addr);
  return MAILTO_EMAIL_RE.test(addr) ? addr : null;
}

// ドメインが「www.」で始まるアドレス(info@www.21service.co.jp: 2365)は、Webサーバーの名前でメールの受け口(MX)が
// 無いことが多く、送っても届かない。「www.」を外した残りが会社のサイトと同じドメインなら外す(info@21service.co.jp)。
// 合わないときはそのまま返し、lib/email-placeholder.js が入力例と同じ扱いにする(登録・送信しない)
function stripWwwFromEmail(email, siteHost) {
  const addr = String(email || "").trim();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return addr;
  const domain = addr.slice(at + 1).toLowerCase();
  if (!/^www\./.test(domain)) return addr;
  const bare = domain.replace(/^www\./, "");
  return siteHost && bare.includes(".") && sameCompanyDomain(bare, siteHost) ? `${addr.slice(0, at)}@${bare}` : addr;
}

// collectEmailSourcesInBrowser の結果からアドレスの候補を作る(mailto: を先に)
function emailsFromSources(sources) {
  if (!sources) return [];
  // 「mailto:a@x.jp,b@x.jp」のように複数のアドレスが並ぶリンクは、1つずつに分けて確かめる
  const mailtos = (sources.mailtos || [])
    .flatMap((m) => String(m || "").split(/[,;]/))
    .map(cleanMailtoAddress)
    .filter(Boolean);
  const out = new Set([...mailtos, ...findEmailsInText(sources.text)]);
  return Array.from(out);
}

module.exports = { collectEmailSourcesInBrowser, findEmailsInText, emailsFromSources, cleanMailtoAddress, stripWwwFromEmail };
