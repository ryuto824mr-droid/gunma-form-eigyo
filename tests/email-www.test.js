// メールアドレスのドメインの「www.」を、会社のサイトと同じドメインなら外すこと
// (lib/email-extract.js の stripWwwFromEmail と、lib/form-analyzer.js の pickEmail の組み合わせ)のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const { stripWwwFromEmail } = require("../lib/email-extract");
const { pickEmail } = require("../lib/form-analyzer");

test("「www.」を外した残りが会社のサイトと同じドメインなら外す(2365 info@www.21service.co.jp)", () => {
  assert.equal(stripWwwFromEmail("info@www.21service.co.jp", "21service.co.jp"), "info@21service.co.jp");
  assert.equal(stripWwwFromEmail("Info@WWW.21service.co.jp", "www.21service.co.jp"), "Info@21service.co.jp");
  assert.equal(stripWwwFromEmail("info@www.shop.example.co.jp", "example.co.jp"), "info@shop.example.co.jp");
});

test("サイトと違うドメイン・サイトが分からない・「www.」で始まらないアドレスは変えない", () => {
  assert.equal(stripWwwFromEmail("info@www.other-corp.co.jp", "21service.co.jp"), "info@www.other-corp.co.jp");
  assert.equal(stripWwwFromEmail("info@www.21service.co.jp", ""), "info@www.21service.co.jp");
  assert.equal(stripWwwFromEmail("info@21service.co.jp", "21service.co.jp"), "info@21service.co.jp");
  assert.equal(stripWwwFromEmail("www@21service.co.jp", "21service.co.jp"), "www@21service.co.jp");
  assert.equal(stripWwwFromEmail("info@www.jp", "www.jp"), "info@www.jp", "外すと組織名が残らない形は変えない");
});

test("リサーチで選ぶアドレス: サイトと同じなら「www.」を外して選び、違うなら選ばない", () => {
  const site = "21service.co.jp";
  assert.equal(pickEmail(["info@www.21service.co.jp"].map((e) => stripWwwFromEmail(e, site))), "info@21service.co.jp");
  assert.equal(pickEmail(["info@www.other-corp.co.jp"].map((e) => stripWwwFromEmail(e, site))), null);
  assert.equal(pickEmail(["info@www.other-corp.co.jp", "tanaka@21service.co.jp"].map((e) => stripWwwFromEmail(e, site))), "tanaka@21service.co.jp");
});
