// lib/email-placeholder.js
//
// 問い合わせフォームの入力例(「例: sample@xxx.co.jp」)やサイトのひな形の仮アドレス(info@mysite.com)を
// 実在のメールアドレスと区別する。リサーチのメール抽出(lib/form-analyzer.js)で拾わないようにするのと、
// 既に登録されてしまったアドレスへのメール送信を送信前に止める(api/send-email.js)のに使う。
//
// ドメイン abc.jp は実在の可能性があるため判定に使わない(@の前の abc / abcde は入力例として扱う)。
// info@ / mail@ / contact@ など、実際によく使われる@の前は入力例として扱わない。

// @の前が入力例のもの
const PLACEHOLDER_LOCAL_RE = /^(sample|example|test|dummy|hoge|name|your[a-z._-]*|abc|abcde|x+|a+)$/i;

// ドメインが入力例のもの(例: mysite.com / mysite.co.jp / example.net / sample.co.jp / test.jp / domain.com / yourdomain.jp)
const PLACEHOLDER_DOMAIN_RE = /^((mysite|example|sample|test|domain|yourdomain|your-domain|hoge)\.[a-z.]+)$/i;

// 組織名の無いドメイン(例: sample@co.jp)
const BARE_SLD_RE = /^(co|ne|or|ac|go|gr|ed|lg)\.jp$/i;

// ドメインの名前部分が記号だけ(例: info@○○○○○○○.co.jp / info@＊＊＊.jp。サイトのひな形に残った伏せ字)
const SYMBOL_LABEL_RE = /^[○●◯◎◇◆□■△▲☆★＊*×✕・･…]+$/;

// メールアドレスとして送れる形(英数字と . _ % + - だけ。空白・改行・見えない文字・全角・URLの符号を含まない)。
// 1805「info@○○○○○○○.co.jp」・1817「info@noguch%69f\n.com」・1219「(U+200B)info@mysite.co.jp」のように、
// 拾ったまま保存された形の崩れたアドレスは、送っても届かないため入力例と同じ扱いにする
const SENDABLE_EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function isPlaceholderEmail(email) {
  const addr = String(email || "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return { placeholder: false, reason: null };
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);

  if (domain.split(".").some((label) => SYMBOL_LABEL_RE.test(label))) {
    return { placeholder: true, reason: `ドメインが伏せ字(${domain})` };
  }
  if (!SENDABLE_EMAIL_RE.test(addr)) return { placeholder: true, reason: "アドレスの形でない(記号・空白・見えない文字・URLの符号を含む)" };
  if (PLACEHOLDER_LOCAL_RE.test(local)) return { placeholder: true, reason: `@の前が入力例(${local})` };
  if (PLACEHOLDER_DOMAIN_RE.test(domain)) return { placeholder: true, reason: `ドメインが入力例(${domain})` };
  if (BARE_SLD_RE.test(domain)) return { placeholder: true, reason: `組織名の無いドメイン(${domain})` };
  // ドメインの名前部分がxだけ(例: xxx.xxx / xxxxxxxxxx.co.jp)
  if (domain.split(".").some((label) => /^x+$/.test(label))) {
    return { placeholder: true, reason: `ドメインが入力例(${domain})` };
  }
  return { placeholder: false, reason: null };
}

module.exports = { isPlaceholderEmail, SENDABLE_EMAIL_RE };
