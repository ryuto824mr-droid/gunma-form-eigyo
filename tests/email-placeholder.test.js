// 入力例・仮のメールアドレスの判定(lib/email-placeholder.js)のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const { isPlaceholderEmail } = require("../lib/email-placeholder");

// 本番の企業データで見つかった仮アドレス(2026-10-10時点。bandotaro@abc.jp は実在の可能性があるため除く)
const FOUND_PLACEHOLDERS = [
  "info@mysite.com", "name@relay.town", "xxx@xxx.xxx", "xxx@xxxxxxxxxx.co.jp", "xxxx@xxxx.xxx",
  "xxx@icho.co.jp", "sample@gku.co.jp", "info@sample.co.jp", "example@xxxxxx.co.jp", "sample@yasaiclub.co.jp",
  "example@example.net", "sample@akn.jp", "abcde@sample.com", "sample@co.jp", "sample@gunmasyokuniku.co.jp",
];

test("本番で見つかった仮アドレスはすべて入力例と判定する", () => {
  for (const e of FOUND_PLACEHOLDERS) {
    const r = isPlaceholderEmail(e);
    assert.equal(r.placeholder, true, e);
    assert.ok(r.reason, e);
  }
});

test("ドメイン abc.jp は判定に使わない(実在の可能性があるため)", () => {
  assert.equal(isPlaceholderEmail("bandotaro@abc.jp").placeholder, false);
  // @の前が abc / abcde なら入力例
  assert.equal(isPlaceholderEmail("abc@foo.co.jp").placeholder, true);
  assert.equal(isPlaceholderEmail("abcde@foo.co.jp").placeholder, true);
});

test("実在のアドレス・よく使われる@の前は入力例と判定しない", () => {
  for (const e of [
    "info@wabika.com", "mail@takasaki-kensetsu.co.jp", "contact@example-corp.co.jp", "matsuzaki9283@gmail.com",
    "info@sanko-mtx.co.jp", "sales@gunei-web.co.jp", "abc-shop@foo.jp", "xavier@foo.com", "info@axxa.co.jp",
    "support@samplebox.jp", "namekawa@foo.jp", "testa@foo.co.jp",
  ]) {
    assert.equal(isPlaceholderEmail(e).placeholder, false, e);
  }
});

test("形の崩れたアドレス(伏せ字のドメイン・URLの符号・改行・見えない文字)は入力例と同じ扱い(1805・1817・1219)", () => {
  for (const [e, reason] of [
    ["info@○○○○○○○.co.jp", /伏せ字/],
    ["info@＊＊＊＊.jp", /伏せ字/],
    ["info@●●.co.jp", /伏せ字/],
    ["info@noguch%69f\n.com", /アドレスの形でない/],
    ["\u200binfo@mysite.co.jp", /アドレスの形でない/],
    ["info@kai sha.co.jp", /アドレスの形でない/],
    ["info@会社.jp", /アドレスの形でない/],
    ["ｉｎｆｏ@kaisha.co.jp", /アドレスの形でない/],
  ]) {
    const r = isPlaceholderEmail(e);
    assert.equal(r.placeholder, true, JSON.stringify(e));
    assert.match(r.reason, reason, JSON.stringify(e));
  }
  // 見えない文字を除いた後の形(mysite.co.jp)も、ひな形の仮アドレスとして扱う
  assert.equal(isPlaceholderEmail("info@mysite.co.jp").placeholder, true);
  // 形が正しく、伏せ字でもないアドレスはこれまでどおり
  for (const e of ["info@noguchif.com", "nagayama-kenntiku@nifty.com", "chigira@tiara.ocn.ne.jp", "info_sales+web@kaisha.co.jp"]) {
    assert.equal(isPlaceholderEmail(e).placeholder, false, e);
  }
});

test("大文字・前後の空白・形式不正", () => {
  assert.equal(isPlaceholderEmail("  SAMPLE@Gku.co.jp ").placeholder, true);
  assert.equal(isPlaceholderEmail("INFO@MYSITE.COM").placeholder, true);
  for (const bad of ["", null, undefined, "noatmark", "@foo.jp", "foo@"]) {
    assert.equal(isPlaceholderEmail(bad).placeholder, false, String(bad));
  }
});

test("ドメインが「www.」で始まるアドレスは仮と同じ扱い(2365 info@www.21service.co.jp)", () => {
  const r = isPlaceholderEmail("info@www.21service.co.jp");
  assert.equal(r.placeholder, true);
  assert.match(r.reason, /Webサーバーの名前/);
  assert.equal(isPlaceholderEmail("info@21service.co.jp").placeholder, false);
  assert.equal(isPlaceholderEmail("www@example-corp.co.jp").placeholder, false, "@の前の www は対象外");
  assert.equal(isPlaceholderEmail("info@wwwork.co.jp").placeholder, false, "www で始まるだけのドメインは対象外");
});
