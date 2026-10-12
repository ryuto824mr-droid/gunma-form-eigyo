// リサーチの問い合わせページ探し(lib/form-analyzer.js の chooseContactLink / matchesFormWord)のテスト。
// 「form」が reform・information・platform 等の単語の一部に一致して、関係のないページを選ばないこと
const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesFormWord, chooseContactLink } = require("../lib/form-analyzer");

test("「form」は区切られた単語・問い合わせ系の組み合わせ・フォームの外部サービスのときだけ一致する", () => {
  for (const s of [
    "/form/", "/pub/form.php", "/form.html", "contact-form", "/form_nomal/", "/forms/d/e/1FAIpQL",
    "/FormMail/service/FormMail.html", "/orderform2", "/mailform/", "/inquiryform.html", "/contactform/",
    "/goukakumae-yoyaku/form", "/n/form/odjb", "/form/?id=711574", "https://ws.formzu.net/dist/S62430217/",
    "contact form", "お問い合わせ form",
  ]) assert.equal(matchesFormWord(s), true, s);
  for (const s of [
    "/reform/", "/information/", "#store-information", "cat.php?cat=information", "#platform",
    "/product-information/", "uniform", "perform", "transform", "format", "formation", "formal",
    "https://www.platform-x.co.jp/contact", "information", "haruhomeのリフォーム", "", null,
  ]) assert.equal(matchesFormWord(s), false, String(s));
});

const L = (href, text) => ({ href: `https://www.example.co.jp${href}`, text: text.toLowerCase() });

test("「Information」「/reform/」が先にあっても「お問い合わせ」を選ぶ(1988の形)", () => {
  const links = [
    L("/information/", "Information"),
    L("/reform/", "HARUHOMEのリフォーム"),
    L("/toi/", "お問い合わせ"),
    L("/sassi/", "資料請求"),
  ];
  assert.equal(chooseContactLink(links), "https://www.example.co.jp/toi/");
});

test("お問い合わせのリンクが見えないときも、広げた探し方で /reform/ や /information/ を選ばない", () => {
  const links = [L("/reform/", "リフォーム"), L("/information/", "Information"), L("/works/", "施工例")];
  assert.equal(chooseContactLink(links, false), null);
  assert.equal(chooseContactLink(links, true), null);
  // 本物のフォームへのリンクは、広げた探し方で従来どおり拾う
  assert.equal(chooseContactLink([...links, L("/mailform/", "メール")], true), "https://www.example.co.jp/mailform/");
  assert.equal(chooseContactLink([...links, L("/entry/", "入力フォーム")], true), "https://www.example.co.jp/entry/");
  assert.equal(chooseContactLink([...links, L("/entry/", "お問い合わせフォーム")], true), "https://www.example.co.jp/entry/");
  // 文字の「フォーム」も、リフォーム・プラットフォーム・ユニフォームの一部には一致させない
  assert.equal(chooseContactLink([L("/a/", "HARUHOMEのリフォーム"), L("/b/", "プラットフォーム"), L("/c/", "ユニフォーム")], true), null);
  assert.equal(chooseContactLink([...links, L("/x/form.php", "こちら")], false), "https://www.example.co.jp/x/form.php", "form.php は採点でも拾う");
});

test("従来どおり: 求人・採用のリンクより一般の問い合わせを優先し、キーワードの多いリンクを選ぶ", () => {
  const links = [
    L("/recruit/contact/", "採用に関するお問い合わせ"),
    L("/company/", "会社案内"),
    L("/contact/", "お問い合わせ"),
  ];
  assert.equal(chooseContactLink(links), "https://www.example.co.jp/contact/");
  assert.equal(chooseContactLink([L("/recruit/contact/", "採用に関するお問い合わせ")]), "https://www.example.co.jp/recruit/contact/", "求人しか無ければそれを返す");
  assert.equal(chooseContactLink([L("/a/", "Contact"), L("/contact-form/", "Contact Form")]), "https://www.example.co.jp/contact-form/");
  assert.equal(chooseContactLink([]), null);
});
