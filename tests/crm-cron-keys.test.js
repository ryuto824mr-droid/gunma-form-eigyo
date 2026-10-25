// ログインの守り(middleware.js)を外したあとも、自動で動く3つの処理
// (run-scheduled-sends・run-send-queue・run-discover)は api/crm.js の中で Vercel の cron の鍵(CRON_SECRET)を
// 確かめることのテスト。鍵が無い・違う・未登録のときは401で、DB・送信処理・企業探しに一度も触らないこと。
// lib/db と api/submit-form・api/send-email をrequireキャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const calls = [];
function fakeSql(strings, ...values) {
  calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
  return Promise.resolve([]);
}
fakeSql.query = async (...args) => { calls.push({ text: String(args[0]) }); return []; };
let settingsCalls = 0;
const sendCalls = [];
function stub(relPath, exports) {
  const p = require.resolve(path.join(__dirname, "..", relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", {
  sql: fakeSql,
  getSettings: async () => { settingsCalls++; return {}; },
  isExcludedDomain: async () => false,
});
stub("api/submit-form", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
stub("api/send-email", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
const handler = require("../api/crm");

const ACTIONS = ["run-scheduled-sends", "run-send-queue", "run-discover"];
const SECRET = "a-long-random-test-secret-value";

function call(action, headers, method = "GET") {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
      setHeader() {},
    };
    handler({ method, query: { action }, headers, body: {} }, res);
  });
}
function reset() {
  calls.length = 0;
  sendCalls.length = 0;
  settingsCalls = 0;
}
function assertUntouched(label) {
  assert.equal(calls.length, 0, `${label}: DBに触らない`);
  assert.equal(settingsCalls, 0, `${label}: 設定も読まない`);
  assert.equal(sendCalls.length, 0, `${label}: 送信しない`);
}

test("前提: middleware.js は無い(入口の守りに頼らず、api/crm.js だけで鍵を確かめる)", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "middleware.js")), false);
});

test("CRON_SECRET が未登録なら、3つとも鍵を付けても401で何もしない", async () => {
  delete process.env.CRON_SECRET;
  for (const action of ACTIONS) {
    reset();
    const r = await call(action, { authorization: `Bearer ${SECRET}` });
    assert.equal(r.status, 401, action);
    assert.match(r.body.error, /CRON_SECRET が登録されていない/, action);
    assertUntouched(action);
  }
});

test("鍵が無い・違う・形が違うときは、3つとも401で何もしない(GET でも POST でも)", async () => {
  process.env.CRON_SECRET = SECRET;
  for (const action of ACTIONS) {
    for (const method of ["GET", "POST"]) {
      for (const headers of [
        {},
        { authorization: "" },
        { authorization: "Bearer wrong" },
        { authorization: SECRET },
        { authorization: `Bearer ${SECRET}x` },
        { authorization: `bearer ${SECRET}` },
        { "x-vercel-cron": "1" },
      ]) {
        reset();
        const label = `${method} ${action} ${JSON.stringify(headers)}`;
        const r = await call(action, headers, method);
        assert.equal(r.status, 401, label);
        assert.match(r.body.error, /認証に失敗しました/, label);
        assertUntouched(label);
      }
    }
  }
  delete process.env.CRON_SECRET;
});
