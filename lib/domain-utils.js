// lib/domain-utils.js
//
// 企業のサイトと、問い合わせページ・メールアドレスのドメインを比べるための判定。
// リサーチ(lib/form-analyzer.js)の問い合わせページ探し・メールの警告と、「あとで送る」の警告
// (lib/later-status.js)で使う。

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

// 登録ドメイン(例: www.wabika.com → wabika.com、shop.example.co.jp → example.co.jp)
function baseDomain(host) {
  const labels = String(host || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const jpSecondLevel = /^(co|or|ne|ac|go|gr|ed|lg)$/;
  const take = labels[labels.length - 1] === "jp" && jpSecondLevel.test(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

// 登録ドメインの会社名の部分(例: kelloggs.jp → kelloggs、fdk.co.jp → fdk、global.fujitsu → global)
function brandLabel(host) {
  return baseDomain(host).split(".")[0] || "";
}

// 会社名として比べない、ありふれたサブドメインの語
const GENERIC_LABELS = new Set([
  "www", "form", "forms", "contact", "mail", "secure", "shop", "support", "help", "helps", "my", "site", "web",
  "app", "apps", "info", "pr", "global", "jp", "en", "corp", "co", "com", "net", "biz",
]);

// 同じ会社のドメインか。登録ドメインが同じ、または一方の会社名の部分が、もう一方のドメインの語に含まれる
// (例: kelloggs.jp と kelloggs.com、agf.ajinomoto.co.jp と agf.jp、pr.fujitsu.com と global.fujitsu)。
// ありふれた語・3文字未満の語では一致させない
function sameCompanyDomain(hostA, hostB) {
  const a = String(hostA || "").toLowerCase().replace(/^www\./, "");
  const b = String(hostB || "").toLowerCase().replace(/^www\./, "");
  if (!a || !b) return false;
  if (baseDomain(a) === baseDomain(b)) return true;
  const labelsA = a.split(".");
  const labelsB = b.split(".");
  const brandA = brandLabel(a);
  const brandB = brandLabel(b);
  const usable = (l) => l && l.length >= 3 && !GENERIC_LABELS.has(l);
  return (usable(brandA) && labelsB.includes(brandA)) || (usable(brandB) && labelsA.includes(brandB));
}

// 外部のフォームサービス(企業が自社サイトの問い合わせに使う正当な外部ドメイン)
const FORM_SERVICE_RE = new RegExp("(^|\\.)(" + [
  "formzu\\.net", "form\\.run", "formrun\\.jp", "docs\\.google\\.com", "forms\\.gle", "tayori\\.com",
  "typeform\\.com", "jotform\\.com", "hsforms\\.com", "hsforms\\.net", "form-mailer\\.jp", "formmailer\\.jp",
  "form\\d*\\.fc2\\.com", "qubo\\.jp", "willap\\.jp", "sesh\\.jp", "questant\\.jp", "forms\\.office\\.com",
  "kintoneapp\\.com", "mailform\\.jp",
].join("|") + ")$", "i");

function isFormServiceHost(host) {
  return FORM_SERVICE_RE.test(String(host || "").toLowerCase());
}

// 問い合わせページとして選んでよいドメインか(同じ会社のドメイン、または外部のフォームサービス)
function isAllowedContactHost(host, companyHosts) {
  if (!host) return false;
  if (isFormServiceHost(host)) return true;
  return (companyHosts || []).filter(Boolean).some((h) => sameCompanyDomain(host, h));
}

// 個人・プロバイダのメール(会社のドメインと違っても警告しない)
const FREE_MAIL_RE = /(^|\.)(gmail\.com|googlemail\.com|yahoo\.co\.jp|ymail\.ne\.jp|outlook\.(com|jp)|hotmail\.(com|co\.jp)|live\.(jp|com)|icloud\.com|me\.com|mac\.com|docomo\.ne\.jp|ezweb\.ne\.jp|au\.com|softbank\.ne\.jp|i\.softbank\.jp|nifty\.com|ocn\.ne\.jp|biglobe\.ne\.jp|so-net\.ne\.jp|plala\.or\.jp|dion\.ne\.jp|wind\.ne\.jp|wakwak\.com|jcom\.home\.ne\.jp|khaki\.plala\.or\.jp)$/i;

function isFreeMailDomain(domain) {
  return FREE_MAIL_RE.test(String(domain || "").toLowerCase());
}

// 同じ会社かを比べるための形(プロジェクトをまたいだ二重送信の防止に使う。lib/cross-project.js)。
// ふつうは登録ドメイン(www・サブドメインの違いは同じ会社)。次はホスト名まで比べる:
//   - 地域型の .jp(town.ora.gunma.jp・city.xxx.lg.jp): baseDomain だと「gunma.jp」にまとまり、
//     別々の町役場・病院を同じ会社とみなしてしまう
//   - 共用のサービス(jimdo・wixsite・sakura.ne.jp 等): 同じドメインに別々の会社のサイトが載る
const PREF_ROMAJI = [
  "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima", "ibaraki", "tochigi", "gunma",
  "saitama", "chiba", "tokyo", "kanagawa", "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano",
  "gifu", "shizuoka", "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama",
  "tottori", "shimane", "okayama", "hiroshima", "yamaguchi", "tokushima", "kagawa", "ehime", "kochi", "fukuoka",
  "saga", "nagasaki", "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa",
];
const GEO_JP_RE = new RegExp(`\\.(${PREF_ROMAJI.join("|")}|lg)\\.jp$`, "i");
const SHARED_HOST_RE = new RegExp("(^|\\.)(" + [
  "jimdo\\.com", "jimdofree\\.com", "jimdosite\\.com", "wixsite\\.com", "wix\\.com", "wixstudio\\.com", "sakura\\.ne\\.jp",
  "fc2\\.com", "hotpepper\\.jp", "ameblo\\.jp", "google\\.com", "goo\\.ne\\.jp", "blogspot\\.com", "wordpress\\.com",
  "crayonsite\\.net", "ocnk\\.net", "shopinfo\\.jp", "gunmablog\\.net", "flop\\.jp", "main\\.jp", "peraichi\\.com",
  "ypole\\.co\\.jp", "sjc\\.ne\\.jp", "studio\\.site", "jp\\.net", "hp-ez\\.com", "webnode\\.jp", "amebaownd\\.com",
  "kannet\\.ne\\.jp", "goo-net\\.com", "imitsu\\.jp", "tabelog\\.com", "hitosara\\.com", "stores\\.jp", "base\\.shop",
  "go\\.jp", "ac\\.jp", "ed\\.jp",
].join("|") + ")$", "i");

function companyKey(url) {
  const host = hostOf(url);
  if (!host) return "";
  if (GEO_JP_RE.test(host) || SHARED_HOST_RE.test(host)) return host;
  return baseDomain(host);
}

module.exports = {
  hostOf, baseDomain, brandLabel, sameCompanyDomain, isFormServiceHost, isAllowedContactHost, isFreeMailDomain, companyKey,
};
