// AIによる欄の判定(lib/form-analyzer.js の mapFieldsWithAI)と、AIの失敗の分類(lib/ai-error.js)のテスト。
// Anthropic APIは global.fetch を偽物に差し替えて呼ばない。ブラウザ・DBも使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { mapFieldsWithAI, buildAIFieldEntries } = require("../lib/form-analyzer");
const { classifyAIError, summarizeAIStatus } = require("../lib/ai-error");
const { isSearchLikeField } = require("../lib/form-requirements");

// 2074(e-N)の形: 普通の欄 + 都道府県のチェックボックス47個 + キーワード検索の欄
const PREFS = Array.from({ length: 47 }, (_, i) => ({ tag: "input", type: "checkbox", name: "tdfk_cd[]", id: `tdfk_${i}`, label: `県${i}` }));
const FORM_2074 = [{
  formIndex: 0,
  fields: [
    { tag: "input", type: "text", name: "name", id: "", label: "お名前" },
    { tag: "input", type: "text", name: "ext_01", id: "", label: "フリガナ" },
    { tag: "input", type: "email", name: "from_mail", id: "", label: "メールアドレス" },
    { tag: "textarea", type: "", name: "ext_03", id: "", label: "お問い合わせ内容" },
    ...PREFS,
    { tag: "input", type: "text", name: "topics_keyword", id: "", placeholder: "キーワード" },
  ],
}];

// 2161(DNN)の形: 150字前後の欄名 + 同じフォームに混ざったサイト内検索の欄
const LONG = "dnn$ctr527$ViewMailForm$grdMain$PageID3$repCategory$ctl01$repField$ItemID17$fldValue$";
const FORM_2161 = [{
  formIndex: 0,
  fields: [
    { tag: "input", type: "text", name: "dnn$ctr805$SearchInput$txtSearch", id: "dnn_ctr805_SearchInput_txtSearch" },
    { tag: "input", type: "text", name: `${LONG}txtCompany`, id: "", label: "会社名" },
    { tag: "input", type: "text", name: `${LONG}txtName`, id: "", label: "お名前" },
    { tag: "textarea", type: "", name: `${LONG}txtMultilineTextBox`, id: "", label: "お問い合わせ内容" },
  ],
}];

let fetchCalls = [];
let reply;
const realFetch = global.fetch;
test.before(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  global.fetch = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return reply();
  };
});
test.after(() => {
  global.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
});
const okReply = (text, stop = "end_turn") => () => ({ ok: true, status: 200, json: async () => ({ stop_reason: stop, content: [{ type: "text", text }] }) });
const errReply = (status, body) => () => ({ ok: false, status, text: async () => body });
const promptOf = () => fetchCalls[fetchCalls.length - 1].body.messages[0].content;

test("検索欄の判定(欄ごと): 検索の欄だけを除き、本文・選択肢・普通の欄は除かない", () => {
  assert.equal(isSearchLikeField({ type: "text", name: "dnn$ctr805$SearchInput$txtSearch" }), true);
  assert.equal(isSearchLikeField({ type: "text", name: "q" }), true);
  assert.equal(isSearchLikeField({ type: "text", name: "topics_keyword" }), true);
  assert.equal(isSearchLikeField({ type: "text", name: "x", label: "キーワード検索" }), true);
  assert.equal(isSearchLikeField({ type: "text", name: "word1" }), false);
  assert.equal(isSearchLikeField({ type: "text", name: "research_area" }), false);
  assert.equal(isSearchLikeField({ tag: "textarea", name: "search_note" }), false, "本文の欄は除かない");
  assert.equal(isSearchLikeField({ type: "checkbox", name: "search_area[]" }), false, "選択肢は除かない");
  assert.equal(isSearchLikeField({ type: "email", name: "email" }), false);
});

test("AIに渡す欄: 同じ名前の選択肢は1つにまとめ、検索の欄は渡さない", () => {
  const built = buildAIFieldEntries(FORM_2074);
  assert.equal(built.entries.length, 5, "4欄 + 都道府県1つ(47個をまとめる)");
  const pref = built.entries.find((e) => e.name === "tdfk_cd[]");
  assert.equal(pref.options, 47);
  assert.ok(!built.entries.some((e) => e.name === "topics_keyword"));
});

test("AIには番号と判定だけを返させ、全部の欄の項目対応に戻す(選択肢は全部に当てはめ、検索の欄は「その他」)", async () => {
  fetchCalls = [];
  reply = okReply('[{"i":0,"r":"contact_person_name","c":"h"},{"i":1,"r":"contact_person_name_kana","c":"h"},{"i":2,"r":"email","c":"h"},{"i":3,"r":"message","c":"h"},{"i":4,"r":"other","c":"m"}]');
  const mapping = await mapFieldsWithAI(FORM_2074);
  assert.equal(mapping.length, FORM_2074[0].fields.length, "元の欄の数と同じ");
  assert.deepEqual(mapping[3], { formIndex: 0, name: "ext_03", id: "", role: "message", confidence: "high" });
  const prefs = mapping.filter((m) => m.name === "tdfk_cd[]");
  assert.equal(prefs.length, 47);
  assert.ok(prefs.every((m) => m.role === "other" && m.confidence === "medium"));
  assert.deepEqual(mapping[mapping.length - 1], { formIndex: 0, name: "topics_keyword", id: "", role: "other", confidence: "high" });
  // 依頼文: 返す形は番号・判定・確信度だけ。都道府県は1行(options: 47)で渡す
  assert.match(promptOf(), /"i":0,"r":"email","c":"h"/);
  assert.equal((promptOf().match(/tdfk_cd/g) || []).length, 1);
  assert.match(promptOf(), /"options":47/);
  assert.equal(fetchCalls[0].body.max_tokens, 2000, "上限は変えない");
});

test("長い欄名は末尾を残して短くして渡し、保存する name は元のまま", async () => {
  fetchCalls = [];
  reply = okReply('[{"i":0,"r":"company_name","c":"h"},{"i":1,"r":"contact_person_name","c":"h"},{"i":2,"r":"message","c":"h"}]');
  const mapping = await mapFieldsWithAI(FORM_2161);
  assert.ok(!promptOf().includes(LONG), "長い欄名をそのまま渡さない");
  assert.match(promptOf(), /…[^"]*txtMultilineTextBox/);
  assert.ok(!promptOf().includes("txtSearch"), "検索の欄は渡さない");
  assert.equal(mapping[0].role, "other");
  assert.equal(mapping[3].name, `${LONG}txtMultilineTextBox`);
  assert.equal(mapping[3].role, "message");
});

test("AIが返さなかった欄・おかしな役割名の欄は簡易判定で補う", async () => {
  reply = okReply('[{"i":0,"r":"phone_number","c":"h"},{"i":2,"r":"email","c":"x"}]');
  const mapping = await mapFieldsWithAI(FORM_2074);
  assert.equal(mapping[0].role, "contact_person_name", "おかしな役割名 → 簡易判定(お名前)");
  assert.equal(mapping[1].role, "contact_person_name_kana", "返さなかった → 簡易判定(フリガナ)");
  assert.deepEqual([mapping[2].role, mapping[2].confidence], ["email", "medium"], "確信度が不明なら medium");
});

test("出力が上限で切れたら、その旨をはっきり記録する", async () => {
  reply = okReply('[{"i":0,"r":"contact_person_name","c":"h"},{"i":1,', "max_tokens");
  await assert.rejects(mapFieldsWithAI(FORM_2074), (err) => {
    assert.match(err.message, /AIの出力が上限\(2000トークン\)で切れました\(AIに渡した欄5個\)/);
    assert.equal(classifyAIError(err.message).kind, "truncated");
    return true;
  });
});

test("クレジット不足・形式が不正な出力は、種類の分かるエラーにする", async () => {
  reply = errReply(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
  await assert.rejects(mapFieldsWithAI(FORM_2074), (err) => classifyAIError(err.message).kind === "credit");
  reply = okReply('{"i":0}');
  await assert.rejects(mapFieldsWithAI(FORM_2074), (err) => /配列ではありません/.test(err.message) && classifyAIError(err.message).kind === "parse");
  reply = okReply("申し訳ありません");
  await assert.rejects(mapFieldsWithAI(FORM_2074), (err) => classifyAIError(err.message).kind === "parse");
});

test("AIのエラーの分類", () => {
  assert.equal(classifyAIError(null), null);
  assert.deepEqual(classifyAIError("Claude APIエラー (status 400): ... Your credit balance is too low ..."), { kind: "credit", label: "クレジット不足" });
  assert.equal(classifyAIError('Claude APIエラー (status 401): {"type":"authentication_error"}').kind, "auth");
  assert.equal(classifyAIError("ANTHROPIC_API_KEY が環境変数に設定されていません").kind, "auth");
  assert.equal(classifyAIError("Claude APIエラー (status 429): rate_limit_error").kind, "rate");
  assert.equal(classifyAIError("Claude APIエラー (status 529): overloaded_error").kind, "rate");
  assert.equal(classifyAIError("Claude APIの出力をJSONとして解析できませんでした: [").kind, "parse");
  assert.equal(classifyAIError("訴求タグの出力をJSONとして解析できませんでした: x").kind, "parse");
  assert.equal(classifyAIError("通信エラー: fetch failed").kind, "network");
  assert.equal(classifyAIError("Claude APIエラー (status 500): internal").kind, "other");
});

test("直近7日のAI判定の状況: 今も失敗中か、回復済みかを区別する", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const credit = "Claude APIエラー (status 400): Your credit balance is too low";
  // クレジット不足が最後(成功より新しい)→ 止まっている
  let st = summarizeAIStatus([
    { updated_at: "2026-10-12T08:00:00Z", mapping_source: "ai", ai_error: null },
    { updated_at: "2026-10-12T09:00:00Z", mapping_source: "heuristic", ai_error: credit },
    { updated_at: "2026-10-11T09:00:00Z", mapping_source: "heuristic", ai_error: credit },
    { updated_at: "2026-10-01T09:00:00Z", mapping_source: "heuristic", ai_error: credit }, // 7日より前は数えない
    { updated_at: "2026-10-12T10:00:00Z", mapping_source: "heuristic", ai_error: credit, archived: true }, // アーカイブ済みは数えない
  ], now);
  assert.equal(st.failed_7d, 2);
  assert.deepEqual(st.by_kind, { credit: 2 });
  assert.equal(st.failing, true);
  assert.equal(st.blocking, true);
  assert.equal(st.last_failure_label, "クレジット不足");

  // その後にAI判定が成功 → 回復済み(失敗の件数は残すが、止まってはいない)
  st = summarizeAIStatus([
    { updated_at: "2026-10-12T09:00:00Z", mapping_source: "heuristic", ai_error: credit },
    { updated_at: "2026-10-12T11:00:00Z", mapping_source: "ai", ai_error: null },
  ], now);
  assert.equal(st.failed_7d, 1);
  assert.equal(st.failing, false);
  assert.equal(st.blocking, false);
  assert.equal(st.last_success_at, "2026-10-12T11:00:00.000Z");

  // 出力切れ・訴求タグだけの失敗も数える。クレジット不足以外は blocking にしない
  st = summarizeAIStatus([
    { updated_at: "2026-10-12T09:00:00Z", mapping_source: "ai", ai_error: null, appeal_error: "Claude APIエラー (status 529): overloaded" },
    { updated_at: "2026-10-12T10:00:00Z", mapping_source: "heuristic", ai_error: "AIの出力が上限(2000トークン)で切れました(AIに渡した欄21個)" },
  ], now);
  assert.equal(st.failed_7d, 2);
  assert.deepEqual(st.by_kind, { rate: 1, truncated: 1 });
  assert.equal(st.failing, true);
  assert.equal(st.blocking, false);

  st = summarizeAIStatus([{ updated_at: "2026-10-12T09:00:00Z", mapping_source: "ai", ai_error: null }], now);
  assert.equal(st.failed_7d, 0);
  assert.equal(st.failing, false);
});
