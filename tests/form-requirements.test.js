// 検索欄の誤検出対策と、自動送信に必要な欄の判定(lib/form-requirements.js)のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isSearchLikeForm, missingRequiredRoles, REQUIRED_ROLE_GROUPS } = require("../lib/form-requirements");

const field = (extra) => ({ tag: "input", type: "text", name: "", id: "", label: "", placeholder: "", ...extra });
const form = (...fields) => ({ fields });

test("本番で誤検出されていた検索欄を、検索欄と判定する", () => {
  const cases = {
    "175 NTT東日本(kw / 検索)": form(field({ name: "kw", id: "kw", label: "検索" })),
    "2194 ミツトヨ(キーワードを入力)": form(field({ name: "keyword", placeholder: "キーワードを入力" })),
    "2025 Yaoko(q)": form(field({ name: "q" })),
    "1948 PC DEPOT(sl/tl/query)": form(field({ name: "sl", type: "radio" }), field({ name: "tl", type: "radio" }), field({ name: "query" })),
    "2219 auショップ(調べたいキーワード)": form(field({ name: "word", placeholder: "調べたいキーワードを入力" })),
    "1952 System(ご質問を入力)": form(field({ name: "chat", placeholder: "ご質問を入力してください。" })),
    "148 Restaurant(Search this website)": form(field({ name: "s", placeholder: "Search this website …" })),
    "118 群馬運輸倉庫(フリーワード)": form(field({ name: "f[32394]", label: "フリーワード：" }), field({ name: "cat", tag: "select", type: "select" })),
    "type=search": form(field({ type: "search", name: "x" })),
    "73 MIRAI(お困りですか？キーワード)": form(field({ name: "kw2", placeholder: "何かお困りですか？キーワードを入力してください" })),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(isSearchLikeForm(f), true, name);
});

test("本物の問い合わせフォームは検索欄と判定しない", () => {
  const cases = {
    "本文の欄(textarea)あり": form(field({ name: "q" }), field({ tag: "textarea", type: "text", name: "message" })),
    "お名前・メール・本文": form(field({ name: "your-name", label: "お名前" }), field({ type: "email", name: "your-email" }), field({ tag: "textarea", name: "msg" })),
    "メール欄があればキーワード欄があっても除かない": form(field({ name: "keyword", label: "ご希望のキーワード" }), field({ type: "email", name: "mail" })),
    "お名前と電話(本文はinput)": form(field({ name: "name", label: "お名前" }), field({ name: "tel", label: "電話番号" }), field({ name: "body", label: "お問い合わせ内容" })),
    "54 パワー不動産(例）山田太郎 等)": form(field({ name: "name", placeholder: "例）山田太郎" }), field({ name: "kana", placeholder: "例）ヤマダタロウ" }), field({ type: "email", name: "email" })),
    "欄が無い": form(),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(isSearchLikeForm(f), false, name);
});

test("自動送信に必要な欄: 本文 + (会社名かお名前)", () => {
  const m = (...roles) => roles.map((role) => ({ role }));
  assert.deepEqual(missingRequiredRoles(m("message", "contact_person_name", "email")), []);
  assert.deepEqual(missingRequiredRoles(m("message", "company_name")), []);
  assert.deepEqual(missingRequiredRoles(m("contact_person_name", "email", "phone")), ["本文"], "54 パワー不動産の形");
  assert.deepEqual(missingRequiredRoles(m("message", "email")), ["会社名・お名前"], "1944 グンエイの形");
  assert.deepEqual(missingRequiredRoles(m("other")), ["本文", "会社名・お名前"], "175 NTT東日本の形");
  assert.deepEqual(missingRequiredRoles(null), ["本文", "会社名・お名前"]);
});

test("必須の欄は、送信時(lib/form-submitter.js)の確認と同じ", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "form-submitter.js"), "utf8");
  const block = src.match(/const REQUIRED_ROLE_GROUPS = \[([\s\S]*?)\];/)[1];
  const submitterGroups = [...block.matchAll(/\[([^\]]*)\]/g)].map((g) => [...g[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
  assert.deepEqual(REQUIRED_ROLE_GROUPS.map((g) => g.roles), submitterGroups);
});
