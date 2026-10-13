// lib/email-extract.js
//
// ページからメールアドレスの候補を集める。リサーチ(lib/form-analyzer.js)の問い合わせページと、
// 会社概要の取得(lib/company-info-extractor.js)で開くトップページ(フッターを含む)・会社概要ページの
// 両方で使う。以前は問い合わせページでしか探しておらず、トップや会社概要に書かれたアドレスを拾えなかった。
//
// ブラウザでは mailto: リンクとページの文字だけを集め(collectEmailSourcesInBrowser)、
// 難読化の正規化と抽出は Node 側で行う(findEmailsInText。テストしやすくするため)。

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

// collectEmailSourcesInBrowser の結果からアドレスの候補を作る(mailto: を先に)
function emailsFromSources(sources) {
  if (!sources) return [];
  const out = new Set([...(sources.mailtos || []), ...findEmailsInText(sources.text)]);
  return Array.from(out);
}

module.exports = { collectEmailSourcesInBrowser, findEmailsInText, emailsFromSources };
