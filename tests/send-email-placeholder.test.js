// api/send-email.js の、入力例・仮のメールアドレスへの送信を止める確認のテスト。
// lib/db と lib/gmail-sender をrequireキャッシュで偽物に差し替え、DB・Gmail・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
const sent = [];
let companyEmail = "sample@gku.co.jp";
function fakeSql(strings, ...v) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values: v });
  if (text.includes("FROM companies WHERE id")) {
    return Promise.resolve([{ id: 134, name: "群馬くみあい運輸株式会社", url: "http://www.gku.co.jp/", email: companyEmail, project: "ozukanzukan", archived: false, action_status: "none", research_result: {} }]);
  }
  if (text.includes("FROM message_variants WHERE id")) return Promise.resolve([{ id: 8, project: "ozukanzukan", subject_template: "件名", body_template: "本文" }]);
  if (text.startsWith("INSERT INTO send_logs")) return Promise.resolve([{ id: 999 }]);
  if (text.startsWith("UPDATE send_logs SET status = 'sent'")) return Promise.resolve([{ id: 999, status: "sent" }]);
  return Promise.resolve([]);
}
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({}), isExcludedDomain: async () => false });
stub("lib/gmail-sender", {
  sendEmail: async (args) => { sent.push(args); return { configured: true, messageId: "m1" }; },
  ensureLabel: async () => null,
  addLabelToMessage: async () => null,
});
const handler = require("../api/send-email");

function call(body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", body }, res);
  });
}
function reset(email) {
  calls.length = 0;
  sent.length = 0;
  companyEmail = email;
}

test("入力例・仮のアドレスには送らず、送信記録も作らない", async () => {
  for (const email of ["sample@gku.co.jp", "info@mysite.com", "xxx@xxx.xxx", "name@relay.town", "example@example.net", "sample@co.jp"]) {
    reset(email);
    const r = await call({ company_id: 134, variant_id: 8 });
    assert.equal(r.status, 400, email);
    assert.equal(r.body.type, "placeholder_email", email);
    assert.equal(sent.length, 0, `${email}: Gmailで送信していない`);
    assert.ok(!calls.some((c) => c.text.startsWith("INSERT INTO send_logs")), `${email}: 送信記録を作っていない`);
  }
});

test("通常のアドレスと abc.jp のアドレスは従来どおり送る", async () => {
  for (const email of ["info@gku.co.jp", "bandotaro@abc.jp"]) {
    reset(email);
    const r = await call({ company_id: 134, variant_id: 8 });
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
    assert.equal(sent.length, 1, email);
    assert.equal(sent[0].to, email);
  }
});
