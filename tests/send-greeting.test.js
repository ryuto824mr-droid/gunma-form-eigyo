// 送信処理の宛名の置き換え(api/send-email.js・api/submit-form.js が lib/greeting-name.js を使うこと)のテスト。
// lib/db・lib/gmail-sender・lib/form-submitter はrequireキャッシュで偽物に差し替え、DB・Gmail・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

let company;
const sentMails = [];
const submitCalls = [];
const VARIANT = { id: 8, project: "ozukanzukan", subject_template: "{{company_name}} 様｜群馬の若手10万人に届く採用SNS",
  body_template: "{{company_name}} ご担当者様\nぐんまお仕事図鑑編集部の松崎と申します。\nぐんまお仕事図鑑編集部　松崎流空" };
const PROFILE = { id: 1, project: "ozukanzukan", person_name: "松崎流空", person_name_kana: "まつざきりゅうと",
  company_name: "株式会社LOCLE", email: "matsuzaki9283@gmail.com", phone: "027-212-2117" };
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (text.includes("FROM sender_profiles")) return Promise.resolve([PROFILE]);
  if (text.includes("FROM companies")) return Promise.resolve([company]);
  if (text.includes("FROM message_variants")) return Promise.resolve([VARIANT]);
  if (text.startsWith("INSERT INTO send_logs")) return Promise.resolve([{ id: 999 }]);
  if (text.startsWith("UPDATE send_logs")) return Promise.resolve([{ id: 999, status: "sent" }]);
  return Promise.resolve([]);
}
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({}), isExcludedDomain: async () => false });
stub("lib/gmail-sender", {
  sendEmail: async (args) => { sentMails.push(args); return { configured: true, messageId: "m1" }; },
  ensureLabel: async () => null,
  addLabelToMessage: async () => null,
});
stub("lib/form-submitter", {
  submitForm: async (url, fieldValues, options) => {
    submitCalls.push({ url, fieldValues, options });
    return { status: "success", resultUrl: url, resultTitle: "", filledFields: [] };
  },
});
const sendEmail = require("../api/send-email");
const submitForm = require("../api/submit-form");

function call(handler, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", body }, res);
  });
}
const base = (over) => ({
  id: 2267, url: "http://www.gunma-sougou.com/", email: "info@gunma-sougou.example.jp", project: "ozukanzukan",
  archived: false, action_status: "none", contact_form_url: "http://www.gunma-sougou.com/contact",
  research_result: { automatable: true, fieldMapping: [
    { role: "contact_person_name", name: "name" }, { role: "email", name: "email" },
    { role: "subject", name: "subject" }, { role: "message", name: "message" },
  ] },
  ...over,
});
const BROKEN = { name: "群馬総合保険株式会社は損害保険・生命保険を幅広くお客様にサービスを提供する", company_info: { official_name: "株式会社は損害保険" } };
const GOOD = { name: "群馬総合保険", company_info: { official_name: "群馬総合保険株式会社" } };

test("メール: 宛名が不確かなら、件名は「群馬の若手…」から、本文は「ご担当者様」から始める", async () => {
  sentMails.length = 0;
  company = base(BROKEN);
  const r = await call(sendEmail, { company_id: 2267, variant_id: 8 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sentMails[0].subject, "群馬の若手10万人に届く採用SNS");
  assert.match(sentMails[0].body, /^ご担当者様\n/);
  assert.ok(!/株式会社は損害保険/.test(sentMails[0].subject + sentMails[0].body));
});

test("メール: 宛名が使えれば従来どおり名前を入れる", async () => {
  sentMails.length = 0;
  company = base(GOOD);
  await call(sendEmail, { company_id: 2267, variant_id: 8 });
  assert.equal(sentMails[0].subject, "群馬総合保険株式会社 様｜群馬の若手10万人に届く採用SNS");
  assert.match(sentMails[0].body, /^群馬総合保険株式会社 ご担当者様\n/);
});

test("フォーム: 件名・本文の欄にも同じ置き換えをする", async () => {
  submitCalls.length = 0;
  company = base(BROKEN);
  const r = await call(submitForm, { company_id: 2267, variant_id: 8 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byRole = Object.fromEntries(submitCalls[0].fieldValues.map((f) => [f.role, f.value]));
  assert.equal(byRole.subject, "群馬の若手10万人に届く採用SNS");
  assert.match(byRole.message, /^ご担当者様\n/);

  submitCalls.length = 0;
  company = base(GOOD);
  await call(submitForm, { company_id: 2267, variant_id: 8 });
  const good = Object.fromEntries(submitCalls[0].fieldValues.map((f) => [f.role, f.value]));
  assert.match(good.message, /^群馬総合保険株式会社 ご担当者様\n/);
});
