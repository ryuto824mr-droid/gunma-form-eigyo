// 送信者プロフィールの値が、実際のフォームの欄に正しく入って送信されるかの通しテスト。
// 127.0.0.1にテスト用フォームを立て、api/submit-form.js(DBのみ偽物、form-submitterとブラウザは本物)で
// 最後まで送信し、サーバーが受け取った値を確認する。送信先はローカルのみで外部には一切送らない。
// 実行: npm run test:e2e (puppeteerのブラウザを使うため通常のnpm testには含めない)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const querystring = require("querystring");

const PROFILE = {
  id: 1, project: "ozukanzukan",
  person_name: "松崎流空",
  person_name_kana: "まつざきりゅうと",
  company_name: "株式会社LOCLE",
  email: "matsuzaki9283@gmail.com",
  phone: "027-212-2117",
};

const page = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>お問い合わせ</h1><form method="post" action="/done/${title}">${inner}
<p><label for="message">お問い合わせ内容</label><textarea id="message" name="message"></textarea></p>
<p><button type="submit">送信する</button></p></form></body></html>`;
const row = (labelText, input) => `<p><label>${labelText}${input}</label></p>`;

// テスト用フォーム: 名前 → { html, fieldMapping(リサーチ結果の項目対応) }
const FIXTURES = {
  basic: {
    html: page("basic",
      row("お名前", '<input type="text" name="name">') +
      row("ふりがな", '<input type="text" name="kana">') +
      row("会社名", '<input type="text" name="company">') +
      row("メールアドレス", '<input type="email" name="email">') +
      row("メールアドレス（確認用）", '<input type="email" name="email_confirm">') +
      row("電話番号", '<input type="tel" name="tel">')),
    fieldMapping: [
      { role: "contact_person_name", name: "name" },
      { role: "contact_person_name_kana", name: "kana" },
      { role: "company_name", name: "company" },
      { role: "email", name: "email" },
      { role: "phone", name: "tel" },
      { role: "message", name: "message" },
    ],
  },
  katakana: {
    html: page("katakana",
      row("お名前", '<input type="text" name="name">') +
      row("フリガナ", '<input type="text" name="kana">') +
      row("ふりがな（全角カタカナ）", '<input type="text" name="kana2">') +
      row("貴社名", '<input type="text" name="company">') +
      row("メールアドレス", '<input type="email" name="email">') +
      row("電話番号（ハイフンなしで入力してください）", '<input type="tel" name="tel">')),
    fieldMapping: [
      { role: "contact_person_name", name: "name" },
      { role: "contact_person_name_kana", name: "kana" },
      { role: "contact_person_name_kana", name: "kana2" },
      { role: "company_name", name: "company" },
      { role: "email", name: "email" },
      { role: "phone", name: "tel" },
      { role: "message", name: "message" },
    ],
  },
  // ふりがな欄に表示ラベルが無い(リサーチの項目対応だけでふりがなと分かっている)フォーム
  nolabel: {
    html: page("nolabel",
      row("お名前", '<input type="text" name="name">') +
      '<div><input type="text" name="field3"></div>' +
      '<div><input type="text" name="user_kana"></div>' +
      row("会社名", '<input type="text" name="company">') +
      row("メールアドレス", '<input type="email" name="email">')),
    fieldMapping: [
      { role: "contact_person_name", name: "name" },
      { role: "contact_person_name_kana", name: "field3" },
      { role: "contact_person_name_kana", name: "user_kana" },
      { role: "company_name", name: "company" },
      { role: "email", name: "email" },
      { role: "message", name: "message" },
    ],
  },
  phone: {
    html: page("phone",
      row("お名前", '<input type="text" name="name">') +
      row("メールアドレス", '<input type="email" name="email">') +
      row("電話番号A", '<input type="number" name="tel_number">') +
      row("電話番号B", '<input type="tel" name="tel_max11" maxlength="11">') +
      row("電話番号C", '<input type="tel" name="tel_pattern" pattern="\\d{10,11}">') +
      '<div class="tel3"><span>電話番号（分割）</span><input type="tel" name="tel1" maxlength="4">-<input type="tel" name="tel2" maxlength="4">-<input type="tel" name="tel3" maxlength="4"></div>'),
    fieldMapping: [
      { role: "contact_person_name", name: "name" },
      { role: "email", name: "email" },
      { role: "phone", name: "tel_number" },
      { role: "phone", name: "tel_max11" },
      { role: "phone", name: "tel_pattern" },
      { role: "phone", name: "tel1" },
      { role: "message", name: "message" },
    ],
  },
};

// ---- テスト用フォームのサーバー(127.0.0.1のみ) ----
const received = {}; // フォーム名 → 受け取った値
let server;
let baseUrl;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const m = req.url.match(/^\/(form|done)\/(\w+)$/);
      if (!m || !FIXTURES[m[2]]) { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (m[1] === "form") return res.end(FIXTURES[m[2]].html);
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        (received[m[2]] = received[m[2]] || []).push(querystring.parse(body));
        res.end("<!doctype html><html><head><meta charset='utf-8'><title>送信完了</title></head><body><p>お問い合わせありがとうございました。送信が完了しました。</p></body></html>");
      });
    }).listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

// ---- api/submit-form.js(DBだけ偽物) ----
const inserts = [];
let currentFixture = null;
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (text.includes("FROM sender_profiles")) return Promise.resolve([PROFILE]);
  if (text.includes("FROM companies")) {
    return Promise.resolve([{
      id: 1, name: "テスト会社", url: baseUrl, project: "ozukanzukan", archived: false, action_status: null,
      contact_form_url: `${baseUrl}/form/${currentFixture}`,
      research_result: { automatable: true, fieldMapping: FIXTURES[currentFixture].fieldMapping },
    }]);
  }
  if (text.includes("FROM message_variants")) {
    return Promise.resolve([{ id: 7, project: "ozukanzukan", subject_template: "件名", body_template: "{{company_name}} ご担当者様\nぐんまお仕事図鑑編集部　松崎流空" }]);
  }
  if (text.includes("INSERT INTO send_logs")) {
    inserts.push({ fixture: currentFixture, values });
    return Promise.resolve([{ id: inserts.length }]);
  }
  return Promise.resolve([]);
}
const dbPath = require.resolve(path.join(__dirname, "..", "..", "lib", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { sql: fakeSql, getSettings: async () => ({}), isExcludedDomain: async () => false } };
const handler = require("../../api/submit-form");

function submit(fixture) {
  currentFixture = fixture;
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    handler({ method: "POST", body: { company_id: 1, variant_id: 7, force: true } }, res);
  });
}

test.before(startServer);
test.after(() => server.close());

test("基本のフォーム: 氏名・ひらがなのふりがな・会社名・メール(確認用も)・電話番号", { timeout: 90000 }, async () => {
  const r = await submit("basic");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [v] = received.basic;
  assert.equal(v.name, "松崎流空");
  assert.equal(v.kana, "まつざきりゅうと");
  assert.equal(v.company, "株式会社LOCLE");
  assert.equal(v.email, "matsuzaki9283@gmail.com");
  assert.equal(v.email_confirm, "matsuzaki9283@gmail.com");
  assert.equal(v.tel, "027-212-2117");
});

test("カタカナ指定のふりがな欄とハイフンなし指定の電話番号欄", { timeout: 90000 }, async () => {
  const r = await submit("katakana");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [v] = received.katakana;
  assert.equal(v.kana, "マツザキリュウト");
  assert.equal(v.kana2, "マツザキリュウト");
  assert.equal(v.company, "株式会社LOCLE");
  assert.equal(v.tel, "0272122117");
});

test("ラベルなしのふりがな欄はカタカナ", { timeout: 90000 }, async () => {
  const r = await submit("nolabel");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [v] = received.nolabel;
  assert.equal(v.field3, "マツザキリュウト", "表示ラベルなし・name属性もふりがなを示さない欄");
  assert.equal(v.user_kana, "マツザキリュウト", "表示ラベルなし・name属性だけがカナを示す欄");
  assert.equal(v.name, "松崎流空");
});

test("電話番号: 数値の欄・最大文字数11・pattern・3分割", { timeout: 90000 }, async () => {
  const r = await submit("phone");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [v] = received.phone;
  assert.equal(v.tel_number, "0272122117");
  assert.equal(v.tel_max11, "0272122117");
  assert.equal(v.tel_pattern, "0272122117");
  assert.deepEqual([v.tel1, v.tel2, v.tel3], ["027", "212", "2117"]);
});

test("send_logsに送信者の写しと実際の入力値が記録される", () => {
  const byFixture = Object.fromEntries(inserts.map(i => [i.fixture, i.values]));
  for (const fixture of Object.keys(FIXTURES)) {
    assert.ok(byFixture[fixture], `${fixture}のINSERTがある`);
    const [profileId, snapshotJson, filledJson] = byFixture[fixture].slice(-3);
    assert.equal(profileId, 1);
    assert.equal(JSON.parse(snapshotJson).person_name, "松崎流空");
    assert.ok(filledJson, `${fixture}のfilled_fieldsがある`);
  }
  const filled = (fixture) => JSON.parse(byFixture[fixture].slice(-1)[0]);
  const nolabel = filled("nolabel").filter(f => f.role === "contact_person_name_kana");
  assert.deepEqual(nolabel.map(f => [f.field, f.value, f.filled]), [["field3", "マツザキリュウト", true], ["user_kana", "マツザキリュウト", true]]);
  const basicRoles = filled("basic").map(f => `${f.role}=${f.value}`);
  assert.ok(basicRoles.includes("contact_person_name_kana=まつざきりゅうと"));
  assert.ok(basicRoles.includes("email_confirm=matsuzaki9283@gmail.com"));
  const phoneSplit = filled("phone").find(f => f.role === "phone_split");
  assert.equal(phoneSplit.value, "027 / 212 / 2117");
  console.log(JSON.stringify(Object.fromEntries(Object.keys(FIXTURES).map(f => [f, filled(f)])), null, 1));
});
