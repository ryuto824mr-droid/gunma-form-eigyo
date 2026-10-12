// リサーチ(lib/form-analyzer.js の analyzeForm)の欄のラベル取得と、ラベルの無い欄の判定の通しテスト。
//   - 表の見出し(th)・dt・aria-labelledby からラベルを読む(1986・Block9型4社の実際のフォームの部分で確かめる)
//   - 見出しが別の行・列にある表で、隣の欄の見出しを誤って拾わない
//   - 欄の判定のAI呼び出しは温度0。近くの文字(例:「例）山田 太郎」)もAIに渡す
//   - ラベルの無い欄にAIが名前・メール等を推測で割り当てたら「要確認」で自動送信不可
// フォームの部分は tests/fixtures/forms/*.html(各社の公開ページの<form>を切り出したもの)。
// 127.0.0.1 にテスト用ページを立て、本物のブラウザでリサーチする。Anthropic APIの呼び出しだけを偽物にし、
// 外部には一切アクセスしない。
// 実行: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");

delete process.env.ANTHROPIC_API_KEY;
const { analyzeForm } = require("../../lib/form-analyzer");

const page = (body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>お問い合わせ</title></head><body><h1>お問い合わせ</h1>${body}</body></html>`;
const fixture = (id) => fs.readFileSync(path.join(__dirname, "..", "fixtures", "forms", `${id}.html`), "utf8");

const PAGES = {
  // 見出しが紛らわしい表・定義リスト
  "/tricky/": page(`<form method="post" action="/done">
    <table>
      <tr><th rowspan="2">お名前</th><td><input type="text" name="sei"></td></tr>
      <tr><td><input type="text" name="mei"></td></tr>
    </table>
    <table>
      <tr><th>部署</th><th>役職</th></tr>
      <tr><td><input type="text" name="col_a"></td><td><input type="text" name="col_b"></td></tr>
    </table>
    <table>
      <tr><th>会社名</th><td><input type="text" name="row_company"></td><th>電話</th><td><input type="text" name="row_tel"></td></tr>
    </table>
    <dl><dt>メールアドレス</dt><dd><input type="text" name="dl_mail"></dd><dt>ご住所</dt><dd><input type="text" name="dl_addr"></dd></dl>
    <p><span id="lb-person">ご担当者</span> <input type="text" name="aria_person" aria-labelledby="lb-person"></p>
    <p><label for="msg">お問い合わせ内容</label><textarea id="msg" name="msg"></textarea></p>
    <p><button type="submit">送信</button></p></form>`),
  // ラベルの無い欄だけのフォーム(name="email" type="email" の欄は推測ではない)
  "/unlabeled/": page(`<form method="post" action="/done">
    <div><input type="text" name="a1"></div>
    <div><input type="text" name="a2"></div>
    <div><input type="email" name="email"></div>
    <div><textarea name="body"></textarea></div>
    <p><button type="submit">送信</button></p></form>`),
};
for (const id of ["1986", "2010", "2071", "2047", "2018"]) PAGES[`/f${id}/`] = page(fixture(id));

let server;
let base;
let reply;
let calls = [];
const realFetch = global.fetch;
test.before(() => new Promise((resolve) => {
  global.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.anthropic.com/")) return realFetch(url, init);
    calls.push(JSON.parse(init.body));
    return reply();
  };
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const body = PAGES[req.url.split("?")[0]];
    if (!body) { res.statusCode = 404; return res.end(page("")); }
    res.end(body);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => {
  global.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  server.close();
});
const ok = (text) => () => ({ ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] }) });
const short = (name) => name.replace(/^(data\[)?Block9_1\]?\[item\]/, "");
const labelsOf = (r) => Object.fromEntries(r.forms[0].fields.map((f) => [short(f.name), f.label]));
const rolesOf = (r) => Object.fromEntries(r.fieldMapping.map((m) => [short(m.name), m.role]));

// 各社の公開ページで確かめた正解
const BLOCK9_LABELS = { "[1]": /^お名前/, "[31][text]": /^住所$/, "[7]": /^電話番号$/, "[8][1]": /^メールアドレス/, "[8][2]": /^メールアドレス/, "[9]": /^お問い合わせ内容$/ };
const BLOCK9_ROLES = { "[1]": "contact_person_name", "[31][code]": "postal_code", "[31][text]": "address", "[7]": "phone", "[8][1]": "email", "[8][2]": "email", "[9]": "message" };
const R1986_LABELS = { "element-0": /^お名前/, "element-1": /^メールアドレス/, "element-3": /^電話番号/, "element-4": /^お問い合わせ内容/ };
const R1986_ROLES = { "element-0": "contact_person_name", "element-1": "email", "element-3": "phone", "element-4": "message" };

for (const id of ["2010", "2071", "2047", "2018", "1986"]) {
  test(`${id}: 表の見出し・dt からラベルを読み、AIを使わない判定でも全部の欄が正しく、自動送信可`, { timeout: 90000 }, async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await analyzeForm(`${base}/f${id}/`);
    const [wantLabels, wantRoles] = id === "1986" ? [R1986_LABELS, R1986_ROLES] : [BLOCK9_LABELS, BLOCK9_ROLES];
    const labels = labelsOf(r);
    for (const [name, re] of Object.entries(wantLabels)) assert.match(labels[name], re, `${id} ${name} のラベル`);
    const roles = rolesOf(r);
    for (const [name, role] of Object.entries(wantRoles)) assert.equal(roles[name], role, `${id} ${name} の判定`);
    assert.equal(r.automatable, true);
    assert.deepEqual(r.needsReview, []);
  });
}

test("AIには温度0で、ラベルと近くの文字(例：「例）山田 太郎」)を渡す。正しく判定されれば要確認にしない", { timeout: 90000 }, async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  calls = [];
  reply = ok('[{"i":0,"r":"contact_person_name","c":"h"},{"i":1,"r":"postal_code","c":"h"},{"i":2,"r":"address","c":"h"},{"i":3,"r":"phone","c":"h"},{"i":4,"r":"email","c":"h"},{"i":5,"r":"email","c":"h"},{"i":6,"r":"message","c":"h"}]');
  const r = await analyzeForm(`${base}/f2010/`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].temperature, 0);
  const prompt = calls[0].messages[0].content;
  assert.match(prompt, /"label":"電話番号"/);
  assert.match(prompt, /"hint":"例）山田 太郎"/);
  assert.equal(r.mappingSource, "ai");
  assert.equal(r.automatable, true);
  assert.deepEqual(r.needsReview, []);
  delete process.env.ANTHROPIC_API_KEY;
});

test("見出しが別の行・列にある表では、隣の欄の見出しを拾わない(rowspan・列の見出し行・1行に2欄・dl・aria-labelledby)", { timeout: 90000 }, async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = await analyzeForm(`${base}/tricky/`);
  const labels = labelsOf(r);
  assert.equal(labels.sei, "お名前");
  assert.equal(labels.mei, "", "rowspan の見出しの2行目は空(推測しない)");
  assert.equal(labels.col_a, "", "列の見出し行の表は空");
  assert.equal(labels.col_b, "", "左のセルに入力欄があれば見出しにしない");
  assert.equal(labels.row_company, "会社名");
  assert.equal(labels.row_tel, "電話", "1行に2欄なら近い方の見出し");
  assert.equal(labels.dl_mail, "メールアドレス");
  assert.equal(labels.dl_addr, "ご住所", "dl の2つ目の欄は自分の dt");
  assert.equal(labels.aria_person, "ご担当者");
  assert.equal(labels.msg, "お問い合わせ内容");
});

test("ラベルの無い欄にAIが名前・メールを推測で割り当てたら要確認にし、自動送信不可(理由を記録)", { timeout: 90000 }, async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  reply = ok('[{"i":0,"r":"contact_person_name","c":"m"},{"i":1,"r":"phone","c":"m"},{"i":2,"r":"email","c":"h"},{"i":3,"r":"message","c":"h"}]');
  const r = await analyzeForm(`${base}/unlabeled/`);
  assert.deepEqual(r.needsReview, ["a1=名前", "a2=電話"], 'name="email" type="email" の欄は推測ではないので含めない');
  assert.equal(r.automatable, false);
  assert.match(r.automatableBlockedReason, /^要確認: ラベルの無い欄の判定が推測\(a1=名前、a2=電話\)$/);
  assert.ok(r.analysisWarnings.some((w) => /^⚠ 要確認: ラベルの無い欄の判定が推測です/.test(w)));
  delete process.env.ANTHROPIC_API_KEY;
});
