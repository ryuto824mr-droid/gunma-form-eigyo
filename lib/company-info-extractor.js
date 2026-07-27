// 企業サイトのトップページ(および見つかれば会社概要ページ)から、
// 代表者・設立年・従業員数・事業内容・資本金・採用ページの有無をキーワード近傍の
// テキストからヒューリスティックに抽出する。AI等は使わず正規表現ベースの推定のため、
// 見つからない項目はnullのまま返す。

const REPRESENTATIVE_KEYWORDS = ["代表取締役社長", "代表取締役", "代表者"];
const FOUNDED_KEYWORDS        = ["設立", "創業"];
const EMPLOYEE_KEYWORDS       = ["従業員数"];
const BUSINESS_KEYWORDS       = ["事業内容", "事業概要"];
const CAPITAL_KEYWORDS        = ["資本金"];
const PHONE_KEYWORDS          = ["電話番号", "TEL", "Tel", "電話"];
const PHONE_REGEX             = /0\d{1,4}-\d{1,4}-\d{3,4}|0\d{9,10}/;

const COMPANY_OVERVIEW_LINK_KEYWORDS = [
  "会社概要", "会社案内", "企業情報", "about", "company", "corporate",
];
const HIRING_LINK_KEYWORDS = [
  "採用情報", "採用", "リクルート", "recruit", "careers", "career", "hiring", "join us",
];

async function extractCompanyInfo(page) {
  const info = {
    representative: null,
    founded_year: null,
    employee_count_text: null,
    business_description: null,
    capital: null,
    phone_number: null,
    hiring_status: { hasHiringPage: false, url: null },
  };

  try {
    const topText = await getPageText(page);
    mergeInfo(info, extractInfoFromText(topText));

    const hiringUrlOnTop = await findLinkByKeywords(page, HIRING_LINK_KEYWORDS);
    if (hiringUrlOnTop) {
      info.hiring_status = { hasHiringPage: true, url: hiringUrlOnTop };
    }

    // 会社概要ページへのリンクがあれば追加で読み込んで情報を補完する
    const overviewUrl = await findLinkByKeywords(page, COMPANY_OVERVIEW_LINK_KEYWORDS);
    if (overviewUrl && stripFragment(overviewUrl) !== stripFragment(page.url())) {
      try {
        await page.goto(overviewUrl, { waitUntil: "networkidle2", timeout: 15000 });
        const overviewText = await getPageText(page);
        mergeInfo(info, extractInfoFromText(overviewText));

        if (!info.hiring_status.hasHiringPage) {
          const hiringUrlOnOverview = await findLinkByKeywords(page, HIRING_LINK_KEYWORDS);
          if (hiringUrlOnOverview) {
            info.hiring_status = { hasHiringPage: true, url: hiringUrlOnOverview };
          }
        }
      } catch {
        // 会社概要ページの取得に失敗してもトップページの情報のみで返す
      }
    }
  } catch {
    // 抽出処理全体が失敗しても呼び出し元の処理には影響させない(nullのまま返す)
  }

  return info;
}

function stripFragment(url) {
  return (url || "").split("#")[0];
}

async function getPageText(page) {
  return page.evaluate(() => document.body.innerText || "");
}

async function findLinkByKeywords(page, keywords) {
  try {
    return await page.evaluate((kws) => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const a of anchors) {
        const text = (a.textContent || "").trim().toLowerCase();
        const href = (a.href || "").toLowerCase();
        if (!href || href.startsWith("javascript:")) continue;
        for (const kw of kws) {
          const kwLower = kw.toLowerCase();
          if (text.includes(kwLower) || href.includes(kwLower)) {
            return a.href;
          }
        }
      }
      return null;
    }, keywords);
  } catch {
    return null;
  }
}

function mergeInfo(target, source) {
  for (const key of ["representative", "founded_year", "employee_count_text", "business_description", "capital", "phone_number"]) {
    if (!target[key] && source[key]) target[key] = source[key];
  }
}

function extractInfoFromText(text) {
  return {
    representative:       extractRepresentative(text),
    founded_year:         extractFoundedYear(text),
    employee_count_text:  extractLineNear(text, EMPLOYEE_KEYWORDS),
    business_description: extractBusinessDescription(text),
    capital:               extractLineNear(text, CAPITAL_KEYWORDS),
    phone_number:          extractPhoneNumber(text),
  };
}

function extractPhoneNumber(text) {
  for (const kw of PHONE_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx === -1) continue;
    const window = text.slice(idx, idx + 100);
    const m = window.match(PHONE_REGEX);
    if (m) return m[0];
  }
  return null;
}

function extractRepresentative(text) {
  for (const kw of REPRESENTATIVE_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx === -1) continue;
    const after = text.slice(idx + kw.length, idx + kw.length + 60);
    const m = after.match(/^[\s　]*(?:CEO|社長|会長)?[\s　:：・\-]*([一-龠ぁ-んァ-ヶー]{2,20})/);
    if (m && m[1]) {
      const name = m[1].trim();
      if (name.length >= 2 && name.length <= 20) return name;
    }
  }
  return null;
}

function extractFoundedYear(text) {
  for (const kw of FOUNDED_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx === -1) continue;
    const window = text.slice(Math.max(0, idx - 20), idx + 80);
    const m = window.match(/(18|19|20)\d{2}(?=\s*年)/);
    if (m) return m[0];
  }
  return null;
}

// キーワードを含む行(改行まで)をそのまま抽出する。正規化は行わない
function extractLineNear(text, keywords) {
  for (const kw of keywords) {
    const idx = text.indexOf(kw);
    if (idx === -1) continue;
    const window = text.slice(idx, idx + 150);
    const line = window.split("\n")[0].trim();
    if (line) return line.slice(0, 150);
  }
  return null;
}

function extractBusinessDescription(text) {
  for (const kw of BUSINESS_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx === -1) continue;
    const after = text.slice(idx + kw.length, idx + kw.length + 300).trim();
    if (after) return after.slice(0, 300);
  }
  return null;
}

module.exports = { extractCompanyInfo };
