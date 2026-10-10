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

test("大文字・前後の空白・形式不正", () => {
  assert.equal(isPlaceholderEmail("  SAMPLE@Gku.co.jp ").placeholder, true);
  assert.equal(isPlaceholderEmail("INFO@MYSITE.COM").placeholder, true);
  for (const bad of ["", null, undefined, "noatmark", "@foo.jp", "foo@"]) {
    assert.equal(isPlaceholderEmail(bad).placeholder, false, String(bad));
  }
});
