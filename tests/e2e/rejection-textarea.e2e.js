// リサーチ(lib/form-analyzer.js の analyzeForm)の通しテスト:
//   - 営業お断りを、欄の入力例(placeholder)からも検出する(2204の形)
//   - 「営業部」「営業時間」等の普通の文言だけのフォームは、営業お断りにしない
//   - ラベルの無い複数行の欄をAIが本文と判定しなかったとき、それを本文とみなして自動送信可にする(1986の形)
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。Anthropic APIの呼び出しだけを偽物にし、
// 外部には一切アクセスしない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

process.env.ANTHROPIC_API_KEY = "test-key";
const { analyzeForm } = require("../../lib/form-analyzer");

const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const PAGES = {
  // 2204の形: 本文の欄の入力例だけに営業お断りが書かれている
  "/placeholder/": page("お問い合わせ", `<form method="post" action="/done">
    <p><label>お名前<input type="text" name="name"></label></p>
    <p><label>メールアドレス<input type="email" name="email"></label></p>
    <p><label>お問い合わせ内容<textarea name="body" placeholder="お問い合わせ内容をご記入下さい。（営業メールやご提案に関するメールはご遠慮下さい）"></textarea></label></p>
    <p><button type="submit">送信</button></p></form>`),
  // 普通の文言だけ: 部署の入力例「例）営業部」、営業時間の案内
  "/normal/": page("お問い合わせ", `<p>営業時間 9:00〜18:00(営業時間外のお電話はご遠慮ください)</p>
    <form method="post" action="/done">
    <p><label>会社名<input type="text" name="company"></label></p>
    <p><label>部署<input type="text" name="dept" placeholder="例）営業部"></label></p>
    <p><label>お名前<input type="text" name="name"></label></p>
    <p><label>メールアドレス<input type="email" name="email"></label></p>
    <p><label>お問い合わせ内容<textarea name="body"></textarea></label></p>
    <p><button type="submit">送信</button></p></form>`),
  // 1986の形: ラベルの無い欄だけのフォーム(textarea もラベルなし)
  "/nolabel/": page("お問い合わせ", `<form method="post" action="/done">
    <p><input type="text" name="element-0"></p>
    <p><input type="text" name="element-1"></p>
    <p><input type="radio" name="element-2" value="男性"><input type="radio" name="element-2" value="女性"></p>
    <p><input type="text" name="element-3"></p>
    <p><textarea name="element-4"></textarea></p>
    <p><button type="submit">送信</button></p></form>`),
};

let server;
let base;
let reply;
let prompts = [];
const realFetch = global.fetch;
test.before(() => new Promise((resolve) => {
  global.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.anthropic.com/")) return realFetch(url, init);
    prompts.push(JSON.parse(init.body).messages[0].content);
    return reply();
  };
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const body = PAGES[req.url.split("?")[0]];
    if (!body) { res.statusCode = 404; return res.end(page("Not Found", "")); }
    res.end(body);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => {
  global.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  server.close();
});
const ok = (text) => () => ({ ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] }) });

test("欄の入力例に書かれた営業お断りを検出し、自動送信不可にする", { timeout: 90000 }, async () => {
  reply = ok('[{"i":0,"r":"contact_person_name","c":"h"},{"i":1,"r":"email","c":"h"},{"i":2,"r":"message","c":"h"}]');
  const r = await analyzeForm(base + "/placeholder/");
  assert.equal(r.rejection_detected, true);
  assert.match(r.rejection_text, /ご遠慮下さい/);
  assert.equal(r.automatable, false);
});

test("「例）営業部」「営業時間外のお電話はご遠慮ください」だけのフォームは営業お断りにしない", { timeout: 90000 }, async () => {
  reply = ok('[{"i":0,"r":"company_name","c":"h"},{"i":1,"r":"department","c":"h"},{"i":2,"r":"contact_person_name","c":"h"},{"i":3,"r":"email","c":"h"},{"i":4,"r":"message","c":"h"}]');
  const r = await analyzeForm(base + "/normal/");
  assert.equal(r.rejection_detected, false);
  assert.equal(r.automatable, true);
});

test("ラベルの無い複数行の欄: AIには textarea として渡し、AIが本文と判定しなくても本文とみなして自動送信可にする", { timeout: 90000 }, async () => {
  prompts = [];
  // AIが textarea を「電話」と誤判定した場合(1986で実際に起きた判定)
  reply = ok('[{"i":0,"r":"contact_person_name","c":"m"},{"i":1,"r":"contact_person_name_kana","c":"m"},{"i":2,"r":"other","c":"m"},{"i":3,"r":"email","c":"l"},{"i":4,"r":"phone","c":"l"}]');
  const r = await analyzeForm(base + "/nolabel/");
  assert.match(prompts[0], /"name":"element-4","type":"textarea"/, "AIに textarea であることを伝える");
  assert.equal(r.mappingSource, "ai");
  const ta = r.fieldMapping.find((m) => m.name === "element-4");
  assert.deepEqual([ta.role, ta.confidence], ["message", "low"]);
  assert.ok(r.analysisWarnings.includes("⚠ AIが本文の欄を判定できなかったため、複数行の欄(element-4)を本文とみなしました"));
  assert.equal(r.automatable, true);
});
