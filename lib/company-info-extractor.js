// 企業サイトのトップページ(および見つかれば会社概要ページ)から、
// 代表者・設立年・従業員数・事業内容・資本金・採用ページの有無をキーワード近傍の
// テキストからヒューリスティックに抽出する。AI等は使わず正規表現ベースの推定のため、
// 見つからない項目はnullのまま返す。

const REPRESENTATIVE_KEYWORDS = ["代表取締役社長", "代表取締役", "代表者"];
const FOUNDED_KEYWORDS        = ["設立", "創業"];
const EMPLOYEE_KEYWORDS       = ["従業員数"];
const BUSINESS_KEYWORDS       = ["事業内容", "事業概要", "ごあいさつ", "事業紹介", "会社紹介"];
// 元号の元年(=1年目)が始まる西暦年。西暦 = ERA_BASE_YEARS[元号] + 元号年数 - 1
const ERA_BASE_YEARS = { "明治": 1868, "大正": 1912, "昭和": 1926, "平成": 1989, "令和": 2019 };
const CAPITAL_KEYWORDS        = ["資本金"];
const PHONE_KEYWORDS          = ["電話番号", "TEL", "Tel", "電話"];
const PHONE_REGEX             = /0\d{1,4}-\d{1,4}-\d{3,4}|0\d{9,10}/;

const COMPANY_NAME_KEYWORDS   = ["会社名", "社名"];
const LEGAL_ENTITY_PREFIXES   = ["株式会社", "有限会社", "合同会社", "合資会社"];
const NAME_CHAR_CLASS         = "[一-龠ぁ-んァ-ヶーA-Za-z0-9]";
const TITLE_DELIMITER_REGEX   = /[｜\-−|]/;
const COPYRIGHT_MARK_REGEX    = /©|&copy;|Copyright/i;

const COMPANY_OVERVIEW_LINK_KEYWORDS = [
  "会社概要", "会社案内", "企業情報", "企業案内", "会社情報", "about", "company", "corporate",
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
    official_name: null,
    hiring_status: { hasHiringPage: false, url: null },
  };

  try {
    const topText = await getPageText(page);
    mergeInfo(info, extractInfoFromText(topText));
    info.official_name = await extractOfficialNameForPage(page, topText);

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
        if (!info.official_name) {
          info.official_name = await extractOfficialNameForPage(page, overviewText);
        }

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

// タイトル/コピーライト表記から「株式会社〇〇」のような法人格つきの名称を取り出す。
// 法人格が名称の前(株式会社〇〇)・後(〇〇株式会社)どちらに付くケースにも対応する
function findLegalEntityName(text) {
  if (!text) return null;
  for (const prefix of LEGAL_ENTITY_PREFIXES) {
    const idx = text.indexOf(prefix);
    if (idx === -1) continue;
    const beforeMatch = text.slice(0, idx).match(new RegExp(`(${NAME_CHAR_CLASS}{1,20})$`));
    const afterMatch  = text.slice(idx + prefix.length).match(new RegExp(`^(${NAME_CHAR_CLASS}{1,20})`));
    const before = beforeMatch ? beforeMatch[1] : "";
    const after  = afterMatch ? afterMatch[1] : "";
    if (after) return `${prefix}${after}`;
    if (before) return `${before}${prefix}`;
    return prefix;
  }
  return null;
}

// <title>を区切り文字(｜ - − |)で分割し、法人格を含む部分を優先的に採用する
function extractOfficialNameFromTitle(title) {
  if (!title) return null;
  const parts = title.split(TITLE_DELIMITER_REGEX).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const name = findLegalEntityName(part);
    if (name) return name;
  }
  return null;
}

// フッターのコピーライト表記(© 2024 株式会社〇〇 All Rights Reserved. 等)から抽出する
function extractOfficialNameFromFooter(footerText) {
  if (!footerText) return null;
  const idx = footerText.search(COPYRIGHT_MARK_REGEX);
  if (idx === -1) return null;
  const window = footerText.slice(idx, idx + 150).split(/all rights reserved/i)[0];
  return findLegalEntityName(window);
}

// 代表者情報の抽出と同様、「会社名」「社名」キーワード近傍のテキストを抽出する
function extractOfficialNameFromKeywordText(text) {
  for (const kw of COMPANY_NAME_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx === -1) continue;
    const after = text.slice(idx + kw.length, idx + kw.length + 60);
    const m = after.match(new RegExp(`^[\\s　:：]*(${NAME_CHAR_CLASS}{2,40})`));
    if (m && m[1]) {
      const name = m[1].trim();
      if (name.length >= 2) return name;
    }
  }
  return null;
}

async function getPageTitle(page) {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

async function getFooterText(page) {
  try {
    return await page.evaluate(() => {
      const footer = document.querySelector("footer");
      return footer ? (footer.innerText || "") : "";
    });
  } catch {
    return "";
  }
}

// 優先順位: 1. <title> → 2. フッターのコピーライト表記 → 3. 「会社名」キーワード近傍
async function extractOfficialNameForPage(page, bodyText) {
  const title = await getPageTitle(page);
  const fromTitle = extractOfficialNameFromTitle(title);
  if (fromTitle) return fromTitle;

  const footerText = await getFooterText(page);
  const fromFooter = extractOfficialNameFromFooter(footerText);
  if (fromFooter) return fromFooter;

  return extractOfficialNameFromKeywordText(bodyText);
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
    // 「姓 名」のように姓と名の間に半角/全角スペースが入る表記(例: 永井　辰弥)にも対応する。
    // スペース区切りのパターンを優先的に試し、無ければ従来通り連続した文字列として取り出す
    const m = after.match(/^[\s　]*(?:CEO|社長|会長)?[\s　:：・\-]*(?:([一-龠ァ-ヶー]{1,10})[\s　]([一-龠ぁ-んァ-ヶー]{1,10})|([一-龠ぁ-んァ-ヶー]{2,20}))/);
    if (m) {
      const name = (m[1] && m[2]) ? `${m[1]} ${m[2]}` : m[3];
      if (name && name.length >= 2 && name.length <= 21) return name;
    }
  }
  return null;
}

function extractFoundedYear(text) {
  for (const kw of FOUNDED_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx === -1) continue;
    const windowStart = Math.max(0, idx - 20);
    const window = text.slice(windowStart, idx + 80);

    // 「■創業 昭和21年5月 ■設立 昭和34年8月」のように近傍に複数の年表記が
    // 並記されているケースがあるため、候補をすべて集めてキーワード自身に最も近いものを採用する
    const candidates = [];
    const western = window.match(/(18|19|20)\d{2}(?=\s*年)/);
    if (western) {
      candidates.push({ dist: Math.abs((windowStart + western.index) - idx), value: western[0] });
    }
    for (const era of window.matchAll(/(明治|大正|昭和|平成|令和)(元|\d{1,2})年/g)) {
      const eraYearNum = era[2] === "元" ? 1 : parseInt(era[2], 10);
      const westernYear = ERA_BASE_YEARS[era[1]] + eraYearNum - 1;
      candidates.push({ dist: Math.abs((windowStart + era.index) - idx), value: String(westernYear) });
    }
    if (candidates.length) {
      candidates.sort((a, b) => a.dist - b.dist);
      return candidates[0].value;
    }
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
