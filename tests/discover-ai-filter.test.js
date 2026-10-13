// 企業探しの改善のテスト:
//   (a) AIによる絞り込み(lib/discover-ai-filter.js)の失敗を返し、企業探し(api/discover.js)は
//       自動パイプラインからの呼び出しならその日の候補を返さない(手動検索は結果に警告を付けて返す)。
//       自動パイプライン(api/crm.js)はその日の登録を止めた理由を記録し、「あとで送る」の帯に出す
//   (b) 企業ではないページ(ポータル・百科事典・自治体・政府機関)のドメインを除外する
// lib/db・lib/places-search はrequireキャッシュで偽物に差し替え、Brave・Anthropic は global.fetch を偽物にする
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const inserts = [];
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  if (/^INSERT INTO (discovered_urls|search_history|api_usage_logs|auto_pipeline_logs)/.test(text)) {
    inserts.push({ text, values });
  }
  return Promise.resolve([]);
}
fakeSql.query = async () => [];
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({ skip_weekends_holidays: "false" }), isExcludedDomain: async () => false });
stub("lib/places-search", { searchPlacesAPI: async () => Object.assign([], { debug: { has_key: false } }) });

const { filterResultsWithAIDetailed, filterResultsWithAI } = require("../lib/discover-ai-filter");
const { summarizeDiscoverFailures, AI_FILTER_STOP_PREFIX } = require("../lib/ai-error");
const discover = require("../api/discover");

const WEB = [
  { title: "株式会社テスト製作所", url: "https://www.test-seisakusho.co.jp/" },
  { title: "群馬製造業ネット", url: "https://portal.example.net/gunma" },
];
let anthropicReply;
const realFetch = global.fetch;
test.before(() => {
  process.env.BRAVE_SEARCH_API_KEY = "brave-test";
  process.env.ANTHROPIC_API_KEY = "test-key";
  global.fetch = async (url) => {
    if (String(url).startsWith("https://api.search.brave.com/")) {
      return { ok: true, status: 200, json: async () => ({ web: { results: WEB } }) };
    }
    if (String(url).startsWith("https://api.anthropic.com/")) return anthropicReply();
    throw new Error("想定外の通信: " + url);
  };
});
test.after(() => {
  global.fetch = realFetch;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
const ok = (text, stop = "end_turn") => () => ({ ok: true, status: 200, json: async () => ({ stop_reason: stop, content: [{ type: "text", text }] }) });
const CREDIT = () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' });
const R = [{ name: "A", url: "https://a.example.jp/" }, { name: "B", url: "https://b.example.jp/" }];

test("絞り込み: 失敗(クレジット不足・キー未設定・形式不正・出力切れ)は理由を返し、結果は元のまま", async () => {
  anthropicReply = CREDIT;
  let r = await filterResultsWithAIDetailed(R, "群馬県", "製造業");
  assert.deepEqual(r.results, R);
  assert.match(r.error, /status 400.*credit balance/);

  anthropicReply = ok("該当なし");
  assert.match((await filterResultsWithAIDetailed(R, "", "")).error, /JSONとして解析できませんでした/);
  anthropicReply = ok('{"name":"A"}');
  assert.match((await filterResultsWithAIDetailed(R, "", "")).error, /配列ではありません/);
  anthropicReply = ok('[{"name":"A","url":"https://a.ex', "max_tokens");
  assert.match((await filterResultsWithAIDetailed(R, "", "")).error, /上限\(1000トークン\)で切れました/);

  delete process.env.ANTHROPIC_API_KEY;
  r = await filterResultsWithAIDetailed(R, "", "");
  assert.match(r.error, /ANTHROPIC_API_KEY/);
  assert.deepEqual(await filterResultsWithAI(R, "", ""), R, "従来の関数は結果だけを返す");
  process.env.ANTHROPIC_API_KEY = "test-key";

  assert.deepEqual(await filterResultsWithAIDetailed([], "", ""), { results: [], error: null }, "結果が無ければ呼ばない");
});

test("絞り込み: 成功ならAIが番号で選んだ結果だけを返し、正式な会社名(分からなければ null)を付ける", async () => {
  anthropicReply = ok('[{"i":0,"company":"株式会社エー"},{"i":1,"company":null},{"i":7,"company":"存在しない番号"}]');
  assert.deepEqual(await filterResultsWithAIDetailed(R, "", ""), {
    results: [{ ...R[0], company_name: "株式会社エー" }, { ...R[1], company_name: null }],
    error: null,
  });
});

function callDiscover(body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; } };
    discover({ method: "POST", query: {}, body: { project: "ozukanzukan", industry: "製造業", ...body } }, res);
  });
}

test("企業探し: 自動パイプラインからの呼び出しで絞り込みに失敗したら、候補を返さず記録もしない", async () => {
  inserts.length = 0;
  anthropicReply = CREDIT;
  const r = await callDiscover({ source: "auto_pipeline" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, []);
  assert.match(r.body.ai_filter_error, /credit balance/);
  assert.ok(!inserts.some((i) => /discovered_urls/.test(i.text)), "候補として記録しない(翌日以降に改めて判定する)");
});

test("企業探し: 手動検索で絞り込みに失敗したら、結果はそのまま返し、警告を付ける", async () => {
  anthropicReply = CREDIT;
  const r = await callDiscover({});
  assert.equal(r.body.results.length, 2);
  assert.match(r.body.ai_filter_error, /credit balance/);
});

test("企業探し: 絞り込みに成功すれば、従来どおりAIが選んだ結果を返し、警告は付けない", async () => {
  anthropicReply = ok('[{"i":0,"company":null}]');
  const r = await callDiscover({ source: "auto_pipeline" });
  assert.deepEqual(r.body.results.map((x) => x.url), ["https://www.test-seisakusho.co.jp/"]);
  assert.equal(r.body.ai_filter_error, undefined);
});

test("除外: ポータル・百科事典・地域情報・政府機関・市区町村のサイトを除外し、似た名前の会社は除外しない", () => {
  for (const u of [
    "https://companyinformation.jp/corp/9070001029833/", "https://www.e-map.ne.jp/smt/smbcbank/inf/1/",
    "https://www.wikidata.org/wiki/Q858016", "https://foundation.wikimedia.org/wiki/x", "https://www.hatomarksite.com/search/",
    "https://houjin.always-basics.com/companies/x", "https://snabi.jp/corporations/585", "https://biz.teachme.jp/casestudy/",
    "https://seizogyo-channel.com/", "https://www.shopowner-support.net/x", "https://fields.canpan.info/organization/1",
    "https://www.kochi-seizou.jp/", "https://takasaki2shin.com/", "https://el.e-shops.jp/local/", "https://gunma.mytabi.net/",
    "https://www.hotpepper.jp/strJ000842502/", "https://www.ota-iparks.jp/", "https://www.archinform.net/x",
    "https://warp.da.ndl.go.jp/info:ndljp/pid/1/", "https://www.city.ota.gunma.jp/form/", "https://www.city.midori.gunma.jp/",
    "https://town.kanra.gunma.jp/", "https://www.vill.ueno.gunma.jp/",
  ]) assert.equal(discover.getExclusionReason(u), "domain_match", u);
  for (const u of [
    "https://www.mogikensetsu.com/", "https://www.citylight.co.jp/", "https://cityhall-cafe.jp/",
    "https://townhouse-gunma.co.jp/", "https://www.k-houyu.com/", "https://www.planex-jp.com/",
    "https://www.gojp-tech.co.jp/", "https://www.e-mapping.co.jp/",
  ]) assert.equal(discover.getExclusionReason(u), null, u);
});

test("帯: 自動パイプラインが企業探しの失敗で登録を止めた日を数え、今も止まっているかを返す", () => {
  const stop = (at, raw) => ({ created_at: at, error_message: `${AI_FILTER_STOP_PREFIX}(クレジット不足)ため、今日の企業の登録を止めました: ${raw}` });
  const credit = "Claude APIエラー (status 400): Your credit balance is too low";
  let s = summarizeDiscoverFailures([
    stop("2026-10-12T09:16:00Z", credit),
    { created_at: "2026-10-11T09:16:00Z", error_message: "土日のためスキップしました" },
    stop("2026-10-09T09:16:00Z", credit),
  ]);
  assert.equal(s.discover_stopped_7d, 2);
  assert.equal(s.discover_last_failure_label, "クレジット不足");
  assert.equal(s.discover_failing, true);

  s = summarizeDiscoverFailures([
    { created_at: "2026-10-13T09:16:00Z", error_message: null },
    { created_at: "2026-10-12T09:16:00Z", error_message: "祝日のためスキップしました" },
    stop("2026-10-09T09:16:00Z", credit),
  ]);
  assert.equal(s.discover_stopped_7d, 1);
  assert.equal(s.discover_failing, false, "その後の実行が成功していれば回復済み");

  assert.deepEqual(summarizeDiscoverFailures([]), { discover_stopped_7d: 0, discover_last_failure_at: null, discover_last_failure_label: null, discover_failing: false });
});

test("企業探し: AIが返した正式な会社名が宛名として使える形なら登録名にし、元のタイトルは title_raw に残す", async () => {
  WEB.splice(0, WEB.length,
    { title: "群馬総合保険株式会社は損害保険・生命保険を幅広く提供する", url: "https://www.gunma-sougou.example.jp/" },
    { title: "群馬県太田市の不動産｜大森不動産", url: "https://www.omori.example.jp/" },
    { title: "テスト工業のページ", url: "https://www.test-kogyo.example.jp/" });
  anthropicReply = ok('[{"i":0,"company":"群馬総合保険株式会社"},{"i":1,"company":"大森不動産"},{"i":2,"company":"株式会社"}]');
  const r = await callDiscover({});
  const byUrl = Object.fromEntries(r.body.results.map((x) => [x.url, x]));
  assert.equal(byUrl["https://www.gunma-sougou.example.jp/"].name, "群馬総合保険株式会社");
  assert.equal(byUrl["https://www.gunma-sougou.example.jp/"].title_raw, "群馬総合保険株式会社は損害保険・生命保険を幅広く提供する");
  assert.equal(byUrl["https://www.omori.example.jp/"].name, "大森不動産");
  // 宛名として使えない会社名(法人格だけ)は使わず、元のタイトルのまま(送るときに宛名の検査で「ご担当者様」になる)
  assert.equal(byUrl["https://www.test-kogyo.example.jp/"].name, "テスト工業のページ");
});

test("除外: 検索結果・ランキング・おすすめ・まとめ・比較・導入事例・プレスリリース・【20xx年】のタイトルは企業ではないとして除外する", async () => {
  WEB.splice(0, WEB.length,
    { title: "群馬県のおすすめシステム開発会社12社", url: "https://a1.example.jp/" },
    { title: "「製造業」の検索結果 - マッチング", url: "https://a2.example.jp/" },
    { title: "外壁塗装ランキング", url: "https://a3.example.jp/" },
    { title: "工務店まとめ", url: "https://a4.example.jp/" },
    { title: "保険比較サイト", url: "https://a5.example.jp/" },
    { title: "導入事例 アーカイブ", url: "https://a6.example.jp/" },
    { title: "新工場のプレスリリース", url: "https://a7.example.jp/" },
    { title: "人気の会社【2024年最新版】", url: "https://a8.example.jp/" },
    { title: "株式会社ふつうの製作所", url: "https://ok.example.jp/" });
  anthropicReply = () => ({ ok: false, status: 400, text: async () => "credit balance" }); // 絞り込みなしで除外だけを見る
  const r = await callDiscover({});
  assert.deepEqual(r.body.results.map((x) => x.url), ["https://ok.example.jp/"]);
});
