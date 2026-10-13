// メールの検出の改善(lib/email-extract.js)・ドメインの判定(lib/domain-utils.js)・問い合わせページ探しで
// 外部ドメインを選ばない対策(lib/form-analyzer.js の chooseContactLink)・「あとで送る」の警告(lib/later-status.js)の
// テスト。ブラウザ・DB・外部APIは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { findEmailsInText, emailsFromSources } = require("../lib/email-extract");
const { sameCompanyDomain, isFormServiceHost, isAllowedContactHost, isFreeMailDomain, baseDomain } = require("../lib/domain-utils");
const { chooseContactLink } = require("../lib/form-analyzer");
const { buildLaterList } = require("../lib/later-status");

test("メール: 難読化の型(アットマーク・(at)・あっと・[@]・★☆◎・空白入りの@・[dot]・全角の．)を直して拾う", () => {
  for (const t of [
    "info@kaisha.co.jp", "info[アットマーク]kaisha.co.jp", "info（アットマーク）kaisha.co.jp", "info＠kaisha.co.jp",
    "info(at)kaisha.co.jp", "info（あっと）kaisha.co.jp", "info[@]kaisha.co.jp", "infoアットkaisha.co.jp",
    "info★kaisha.co.jp", "info☆kaisha.co.jp", "info◎kaisha.co.jp", "info @ kaisha.co.jp",
    "info@kaisha[dot]co[dot]jp", "info@kaisha(dot)co(dot)jp", "info★kaisha．co．jp", "info at kaisha dot co dot jp",
    "お問い合わせ: info★kaisha.co.jp (★を@に変えてください)",
  ]) assert.deepEqual(findEmailsInText(t), ["info@kaisha.co.jp"], t);
});

test("メール: アドレスの形にならない文字からは拾わない", () => {
  for (const t of ["アットホームな会社です", "★おすすめ★ 新商品", "営業時間 9:00〜18:00 ☆定休日あり", "TEL 027-123-4567", "", null]) {
    assert.deepEqual(findEmailsInText(t), [], String(t));
  }
});

test("メール: mailto: のリンクを先に、本文の候補を後に、重複なく並べる", () => {
  assert.deepEqual(
    emailsFromSources({ mailtos: ["info@kaisha.co.jp"], text: "sales★kaisha.co.jp / info@kaisha.co.jp" }),
    ["info@kaisha.co.jp", "sales@kaisha.co.jp"],
  );
  assert.deepEqual(emailsFromSources(null), []);
});

test("ドメイン: 同じ会社の別ドメインを見分け、別の会社・掲載サイトとは見分ける", () => {
  for (const [a, b] of [
    ["kelloggs.jp", "kelloggs.com"], ["fdk.co.jp", "fdk.com"], ["agf.ajinomoto.co.jp", "agf.jp"],
    ["meiji.co.jp", "meiji.com"], ["pr.fujitsu.com", "global.fujitsu"], ["www.mogikensetsu.com", "mogikensetsu.com"],
    ["shop.example.co.jp", "example.co.jp"],
  ]) assert.equal(sameCompanyDomain(a, b), true, `${a} ${b}`);
  for (const [a, b] of [
    ["japoncompany.business", "towheree.com"], ["ameblo.jp", "helps.ameba.jp"], ["goo-net.com", "goo-help.my.site.com"],
    ["icho.co.jp", "sonique.co.jp"], ["toushi-athome.jp", "athome.co.jp"], ["ey-net.com", "facebook.com"],
    ["ota-aeonmall.com", "aeon-mall.jp"], ["tkcinc.jp", "aboutnet.jp"], ["a.co.jp", "b.co.jp"],
    ["shop.example.co.jp", "shop.another.co.jp"], // ありふれた語(shop)では一致させない
  ]) assert.equal(sameCompanyDomain(a, b), false, `${a} ${b}`);
  assert.equal(baseDomain("shop.example.co.jp"), "example.co.jp");
});

test("ドメイン: 外部フォームサービス(FC2・qubo・willap・sesh を含む)と、個人・プロバイダのメール", () => {
  for (const h of ["ws.formzu.net", "form.run", "docs.google.com", "forms.gle", "form1.fc2.com", "req.qubo.jp", "willap.jp", "estate.sesh.jp", "tayori.com", "share.hsforms.com"]) {
    assert.equal(isFormServiceHost(h), true, h);
  }
  for (const h of ["peraichi.com", "facebook.com", "towheree.com", "fc2.com", "notsesh.jp"]) assert.equal(isFormServiceHost(h), false, h);
  assert.equal(isAllowedContactHost("kelloggs.com", ["kelloggs.jp"]), true);
  assert.equal(isAllowedContactHost("towheree.com", ["japoncompany.business"]), false);
  for (const d of ["gmail.com", "yahoo.co.jp", "docomo.ne.jp", "icloud.com"]) assert.equal(isFreeMailDomain(d), true, d);
  for (const d of ["kaisha.co.jp", "gmail.co"]) assert.equal(isFreeMailDomain(d), false, d);
});

const L = (href, text) => ({ href, text: text.toLowerCase() });

test("問い合わせページ探し: 企業と別のドメインのリンクは、外部フォームサービスか同じ会社のときだけ選ぶ", () => {
  const hosts = ["kaisha.co.jp"];
  // 掲載サイトのヘルプ・別の会社のフォームが先にあっても、自社の問い合わせを選ぶ
  assert.equal(chooseContactLink([
    L("https://helps.ameba.jp/contact/", "お問い合わせ"),
    L("https://towheree.com/contact", "お問い合わせ"),
    L("https://www.kaisha.co.jp/contact/", "お問い合わせ"),
  ], false, hosts), "https://www.kaisha.co.jp/contact/");
  // 外部フォームサービス・同じ会社の別ドメインは選べる
  assert.equal(chooseContactLink([L("https://ws.formzu.net/dist/S1/", "お問い合わせ")], false, hosts), "https://ws.formzu.net/dist/S1/");
  assert.equal(chooseContactLink([L("https://www.kelloggs.com/contact", "お問い合わせ")], false, ["kelloggs.jp"]), "https://www.kelloggs.com/contact");
  // 関係のない外部リンクしか無ければ選ばない。mailto: も選ばない
  assert.equal(chooseContactLink([L("https://www.facebook.com/x", "お問い合わせ"), L("mailto:info@kaisha.co.jp", "お問い合わせ")], true, hosts), null);
  // 企業のドメインを渡さない従来の呼び方は、これまでどおり絞らない
  assert.equal(chooseContactLink([L("https://towheree.com/contact", "お問い合わせ")]), "https://towheree.com/contact");
});

test("あとで送る: 同じ会社の別ドメイン・外部フォームサービスは別ドメインの警告を出さず、別の会社のフォームには出す", () => {
  const c = (id, url, form) => ({ id, name: `会社${id}`, url, contact_form_url: form, status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" });
  const r = buildLaterList({
    companies: [
      c(275, "https://www.kelloggs.jp/", "https://www.kelloggs.com/ja_JP/contact.html"),
      c(2125, "https://agf.ajinomoto.co.jp/kanren/kanto/", "https://agf.jp/inquiry/"),
      c(298, "https://netsugen.jp/", "https://docs.google.com/forms/d/e/x/viewform"),
      c(142, "https://japoncompany.business/x", "https://towheree.com/contact"),
    ],
    sendLogSummary: [], queueRows: [], scheduledRows: [], senderProfileValid: true, now: Date.parse("2026-10-13T00:00:00Z"),
  });
  const w = (id) => r.items.find((it) => it.company_id === id).warnings.map((x) => x.code);
  assert.ok(!w(275).includes("form_domain_mismatch"));
  assert.ok(!w(2125).includes("form_domain_mismatch"));
  assert.ok(!w(298).includes("form_domain_mismatch"));
  assert.ok(w(142).includes("form_domain_mismatch"));
});

test("あとで送る: 仮アドレスの企業は、未送信の行にも「仮(無効)」の警告を出す", () => {
  const r = buildLaterList({
    companies: [
      { id: 292, name: "杜丸不動産", url: "https://x.jp/", contact_form_url: "https://x.jp/c", email: "toiawase@domain.co.jp", status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" },
      { id: 1, name: "会社1", url: "https://y.jp/", contact_form_url: "https://y.jp/c", email: "info@y.jp", status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" },
    ],
    sendLogSummary: [], queueRows: [], scheduledRows: [], senderProfileValid: true, now: Date.parse("2026-10-13T00:00:00Z"),
  });
  const w292 = r.items.find((it) => it.company_id === 292).warnings.find((x) => x.code === "placeholder_email");
  assert.equal(w292.level, "warn");
  assert.match(w292.message, /仮\(無効\).*toiawase@domain\.co\.jp/);
  assert.ok(!r.items.find((it) => it.company_id === 1).warnings.some((x) => x.code === "placeholder_email"));
});
