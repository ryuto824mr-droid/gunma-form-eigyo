// 保留から送信待ちへの自動の移し替え(api/crm.js の releaseHeldQueueItems)を、営業の対象の地域(area)込みで
// 通すテスト。cron の鍵を付けて run-send-queue を呼び、「あとで送る」の読み込み → area の読み込み → 移す行の選択
// → 送信待ちへの更新と記録(hold_releases)までを確かめる。
//   - ozukanzukan(設定なし=群馬県だけ): 群馬県の★候補は移す。県外は「会社概要の住所が群馬県ではない」で移さない
//   - locle(全国): 大阪府で探した大阪府の会社は移す。見つけた県と違う・県が不明・公共団体は移さない
//   - area の設定が壊れているときは群馬県だけとして動く
//   - もう一方のプロジェクトで送信済みの会社は移さない(二重送信の防止)
//   - 移し替えの段階では送信の処理を呼ばない
// lib/db・api/submit-form・api/send-email は require キャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない。
// 「今日が営業日か」を本物の時計で見るため、Date だけ 2026-10-28(水)12:00(日本時間)に固定する
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const NOW = new Date("2026-10-28T03:00:00Z"); // 水曜 12:00(日本時間)
const HELD_AT = "2026-10-26T09:16:00Z";       // 月曜 18:16(日本時間)に自動パイプラインが保留に積んだ
const HOLD_NOTE = "[保留] 自動パイプラインで追加(検索: 製造業×テスト市)";

const calls = [];
const state = {};
function reset(over = {}) {
  calls.length = 0;
  sendCalls.length = 0;
  Object.assign(state, {
    configs: {},            // project → search_params
    companies: { locle: [], ozukanzukan: [] },
    holds: { locle: [], ozukanzukan: [] },
    otherSent: { locle: [], ozukanzukan: [] }, // そのプロジェクトで送信済みの会社(もう一方から見た送信記録)
  }, over);
  process.env.CRON_SECRET = SECRET;
}
const projectOf = (values) => values.find((v) => v === "locle" || v === "ozukanzukan");
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  const p = projectOf(values);
  // 送信だけの処理の送信待ち(移し替えのあとに読む。このテストでは送らない)
  if (text.startsWith("SELECT * FROM send_queue WHERE status = 'pending'")) return Promise.resolve([]);
  if (text.startsWith("SELECT COUNT(*)::int AS count FROM send_logs")) return Promise.resolve([{ count: 0 }]);
  if (text.startsWith("SELECT search_params FROM auto_pipeline_config")) {
    const c = state.configs[p];
    return Promise.resolve(c ? [{ search_params: c }] : []);
  }
  // 「あとで送る」の読み込み
  if (text.includes("research_result->>'automatable' AS automatable") && text.includes("FROM companies WHERE project")) return Promise.resolve(state.companies[p]);
  if (text.includes("FROM send_queue sq LEFT JOIN message_variants mv") && text.includes("WHERE sq.project")) return Promise.resolve(state.holds[p]);
  if (text.includes("FROM sender_profiles WHERE project")) {
    return Promise.resolve([{ id: 1, project: p, person_name: "松崎流空", person_name_kana: "まつざきりゅうと", company_name: "株式会社LOCLE", email: "a@example.com", phone: "027-000-0000" }]);
  }
  // 二重送信の防止: もう一方のプロジェクトの会社と送信記録
  if (text.startsWith("SELECT id, url, archived FROM companies WHERE project")) return Promise.resolve(state.otherSent[p].map((c) => ({ id: c.id, url: c.url, archived: false })));
  if (text.includes("FROM send_logs sl JOIN companies c") && text.includes("IN ('sent', 'uncertain')") && text.includes("GROUP BY")) {
    return Promise.resolve(state.otherSent[p].map((c) => ({ company_id: c.id, status: "sent", count: 1, last_sent_at: "2026-10-20T09:00:00Z" })));
  }
  // 県外の判定(会社概要)
  if (text.startsWith("SELECT id, company_info FROM companies WHERE id = ANY")) {
    const ids = values[0];
    const all = [...state.companies.locle, ...state.companies.ozukanzukan];
    return Promise.resolve(all.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, company_info: { prefecture: c.company_prefecture, address: c.company_prefecture ? `${c.company_prefecture}テスト市1-1` : null } })));
  }
  if (text.includes("FROM hold_releases hr JOIN send_queue sq")) return Promise.resolve([]);
  if (text.startsWith("UPDATE send_queue SET status = 'pending'")) return Promise.resolve([{ id: values[1] }]);
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
const sendCalls = [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", {
  sql: fakeSql,
  getSettings: async () => ({ skip_weekends_holidays: "false", auto_send_hour: "99", auto_release_hold: "true", daily_send_limit: "100" }),
  isExcludedDomain: async () => false,
});
stub("api/submit-form", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
stub("api/send-email", async (req, res) => { sendCalls.push(req.body); return res.status(200).json({}); });
const handler = require("../api/crm");

const SECRET = "a-long-random-test-secret-value";
function run() {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; }, setHeader() {} };
    handler({ method: "GET", query: { action: "run-send-queue" }, headers: { authorization: `Bearer ${SECRET}` } }, res);
  });
}

// 会社ごとに別の登録ドメインにする(c1.example.jp のような形は、同じ example.jp の別のサブドメインとして
// 同じ会社とみなされる。lib/domain-utils.js の companyKey)
// ★候補の条件(自動送信可・欄がAI・宛名が確か・送信記録なし・フォームが同じドメイン・更新から30日以内)を満たす会社
const company = (id, project, over = {}) => ({
  id, project, name: `株式会社テスト${id}`, url: `https://c${id}-test.co.jp/`, contact_form_url: `https://c${id}-test.co.jp/contact/`,
  email: null, status: "researched", archived: false, action_status: "none", updated_at: "2026-10-26T09:16:00Z",
  official_name: null, automatable: "true", rejection_detected: null, mapping_source: "ai", ai_error: null, appeal_error: null,
  captcha_detected: null, needs_review: null, image_auth_fields: null, phone_number: "027-111-2222",
  company_prefecture: "群馬県", found_prefecture: null, ...over,
});
const hold = (queueId, companyId) => ({
  id: queueId, company_id: companyId, variant_id: 7, variant_name: "動画付き", variant_project: null, channel: "form",
  status: "on_hold", created_at: HELD_AT, updated_at: HELD_AT, error_message: HOLD_NOTE,
});
const released = () => calls.filter((c) => c.text.startsWith("UPDATE send_queue SET status = 'pending'")).map((c) => c.values[1]);
const recorded = () => calls.filter((c) => c.text.startsWith("INSERT INTO hold_releases")).map((c) => c.values[0]);

test.beforeEach(() => test.mock.timers.enable({ apis: ["Date"], now: NOW }));
test.afterEach(() => test.mock.timers.reset());

test("ozukanzukan(設定なし=群馬県だけ): 群馬県の★候補は移し、県外の会社は移さない", async () => {
  reset();
  state.companies.ozukanzukan = [company(1, "ozukanzukan"), company(2, "ozukanzukan", { company_prefecture: "長野県" })];
  state.holds.ozukanzukan = [{ ...hold(101, 1), variant_project: "ozukanzukan" }, { ...hold(102, 2), variant_project: "ozukanzukan" }];
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hold_release.error, undefined, JSON.stringify(r.body.hold_release));
  assert.deepEqual(released(), [101]);
  assert.deepEqual(recorded(), [101]);
  const oz = r.body.hold_release.results.find((x) => x.project === "ozukanzukan");
  assert.equal(oz.released, 1);
  assert.equal(oz.skipped, 1);
});

test("locle(全国): 大阪府で探した大阪府の会社は移す。見つけた県と違う・県が不明・公共団体は移さない", async () => {
  reset({ configs: { locle: { area: { mode: "nationwide" } } } });
  state.companies.locle = [
    company(11, "locle", { company_prefecture: "大阪府", found_prefecture: "大阪府", phone_number: "06-1111-2222" }),
    company(12, "locle", { company_prefecture: "群馬県", found_prefecture: "三重県" }),
    company(13, "locle", { company_prefecture: null, found_prefecture: "大阪府", phone_number: "06-1111-2222" }),
    company(14, "locle", { name: "一般社団法人テスト協会", company_prefecture: "大阪府", found_prefecture: "大阪府", phone_number: "06-1111-2222" }),
  ];
  state.holds.locle = [11, 12, 13, 14].map((id) => ({ ...hold(200 + id, id), variant_project: "locle" }));
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(released(), [211], "大阪府の会社だけ(電話番号が 06 でも、全国なら止めない)");
  const lo = r.body.hold_release.results.find((x) => x.project === "locle");
  assert.equal(lo.released, 1);
  assert.equal(lo.skipped, 3);
});

test("locle の設定が無い・area が壊れているときは群馬県だけとして動き、大阪府の会社は移さない", async () => {
  for (const config of [undefined, { area: { mode: "全国" } }, { area: { mode: "prefectures", prefectures: [] } }]) {
    reset({ configs: config ? { locle: config } : {} });
    state.companies.locle = [company(21, "locle", { company_prefecture: "大阪府", found_prefecture: "大阪府", phone_number: "06-1111-2222" }), company(22, "locle")];
    state.holds.locle = [{ ...hold(221, 21), variant_project: "locle" }, { ...hold(222, 22), variant_project: "locle" }];
    const r = await run();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(released(), [222], JSON.stringify(config));
  }
});

test("もう一方のプロジェクトで送信済みの会社は、★候補にならず移さない(二重送信の防止)", async () => {
  reset({ configs: { locle: { area: { mode: "nationwide" } } } });
  state.companies.locle = [
    company(31, "locle", { url: "https://www.shared-co.co.jp/", contact_form_url: "https://www.shared-co.co.jp/contact/", company_prefecture: "大阪府", found_prefecture: "大阪府" }),
    company(32, "locle", { company_prefecture: "大阪府", found_prefecture: "大阪府" }),
  ];
  state.holds.locle = [{ ...hold(331, 31), variant_project: "locle" }, { ...hold(332, 32), variant_project: "locle" }];
  state.otherSent.ozukanzukan = [{ id: 900, url: "https://shared-co.co.jp/company/" }];
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(released(), [332]);
});

test("移し替えの段階では送信の処理を呼ばない。人が保留にした行(自動パイプラインの保留でない)は移さない", async () => {
  reset();
  state.companies.ozukanzukan = [company(41, "ozukanzukan"), company(42, "ozukanzukan")];
  state.holds.ozukanzukan = [
    { ...hold(441, 41), variant_project: "ozukanzukan" },
    { ...hold(442, 42), variant_project: "ozukanzukan", error_message: "[保留] 人が確認中" },
  ];
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(released(), [441]);
  assert.equal(sendCalls.length, 0, "送信の処理を呼ばない(移した行は次の送信待ちの読み込みで扱う)");
  const upd = calls.find((c) => c.text.startsWith("UPDATE send_queue SET status = 'pending'"));
  assert.match(upd.text, /status = 'on_hold' AND error_message LIKE/, "移す直前に、自動パイプラインの保留のままかを確かめる");
});
