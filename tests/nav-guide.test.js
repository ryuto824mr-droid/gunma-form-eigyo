// 各ページの上部の説明・初めて開いたときの案内(public/nav-menu.js)と、ヘルプ(public/help.html)の
// つながりのテスト。ブラウザ・DB・ネットワークは使わない(ファイルの中身だけを確かめる)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PAGE_INTROS, ROLE_GUIDES, NAV_SECONDARY_ITEMS } = require("../public/nav-menu.js");

const PUBLIC = path.join(__dirname, "..", "public");
const help = fs.readFileSync(path.join(PUBLIC, "help.html"), "utf8");
const helpIds = new Set([...help.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
// 各ページが initNavMenu に渡すキー
const pageKeys = new Set();
for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith(".html"))) {
  const m = fs.readFileSync(path.join(PUBLIC, f), "utf8").match(/initNavMenu\("([^"]+)"\)/);
  if (m) pageKeys.add(m[1]);
}

test("メニューのあるページには、すべて上部の説明がある", () => {
  assert.ok(pageKeys.size >= 14, `ページの数 ${pageKeys.size}`);
  for (const k of pageKeys) {
    assert.ok(PAGE_INTROS[k], `${k} の説明が無い`);
    assert.ok(PAGE_INTROS[k].lines.length >= 1 && PAGE_INTROS[k].lines.length <= 3, `${k} は1〜3行`);
  }
});

test("説明の「くわしく」と役割の手順のリンク先が、ヘルプにある", () => {
  for (const [k, v] of Object.entries(PAGE_INTROS)) assert.ok(helpIds.has(v.help), `${k} → #${v.help} がヘルプに無い`);
  for (const [k, v] of Object.entries(ROLE_GUIDES)) assert.ok(helpIds.has(v.help), `${k} → #${v.help} がヘルプに無い`);
});

test("初めての案内の役割は 管理者・営業担当・全員 の3つ", () => {
  assert.deepEqual(Object.values(ROLE_GUIDES).map((r) => r.label), ["管理者", "営業担当", "全員"]);
  for (const r of Object.values(ROLE_GUIDES)) assert.equal(r.today.length, 3, r.label);
});

test("メニューに「はじめての案内」があり、「ログアウト」は無い(ログインの守りを外したため)", () => {
  const keys = NAV_SECONDARY_ITEMS.map((i) => i.key);
  assert.ok(keys.includes("onboarding"));
  assert.ok(!keys.includes("logout"));
  assert.ok(!NAV_SECONDARY_ITEMS.some((i) => /logout|ログアウト/.test(`${i.href} ${i.label}`)));
});

test("ヘルプ: ログインについて(URL の扱い)・3区分・送信だけの処理・2-B・宛名と住所の検査・アーカイブ・役割から探す の項目と目次がある", () => {
  for (const id of ["role-guide", "role-admin", "role-sales", "role-everyone", "access", "later", "send-schedule", "hold-release", "checks", "archive"]) {
    assert.ok(helpIds.has(id), `#${id}`);
  }
  for (const id of ["role-guide", "access", "send-schedule", "hold-release", "checks", "archive"]) {
    assert.ok(help.includes(`<a href="#${id}">`), `目次に #${id}`);
  }
  // 古い記述が残っていない
  assert.ok(!helpIds.has("login"), "ログイン・ログアウトの項目は「ログインについて(URL の扱い)」に置き換えた");
  assert.ok(!/パスワードを人に教えない|ログアウトする/.test(help), "ログインが無い前提の記述にする");
  assert.ok(!help.includes("住所は保存していないため"), "住所の検査を入れたので、古い記述は消す");
  assert.ok(!help.includes("次の平日 18:00 の自動送信で送られます"), "送信の時刻は自動送信の項目にまとめた");
  // 本文の中のページ内リンクは、すべてヘルプの中にある
  for (const m of help.matchAll(/href="#([^"]+)"/g)) assert.ok(helpIds.has(m[1]), `リンク #${m[1]} の行き先が無い`);
});
