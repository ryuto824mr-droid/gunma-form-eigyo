// リサーチのメール抽出で、入力例・仮のアドレスを選ばないこと(lib/form-analyzer.js の pickEmail)のテスト
const test = require("node:test");
const assert = require("node:assert/strict");
const { pickEmail } = require("../lib/form-analyzer");

test("入力例・仮のアドレスは選ばず、本物を選ぶ(info@優先でも仮アドレスより本物)", () => {
  assert.equal(pickEmail(["info@mysite.com", "tanaka@jin-housing.co"]), "tanaka@jin-housing.co");
  assert.equal(pickEmail(["sample@gku.co.jp", "info@gku.co.jp"]), "info@gku.co.jp");
  assert.equal(pickEmail(["xxx@icho.co.jp", "reserve@icho.co.jp"]), "reserve@icho.co.jp");
  assert.equal(pickEmail(["info@sample.co.jp", "contact@showadenki.co.jp"]), "contact@showadenki.co.jp");
});

test("入力例しか無ければ null(登録しない)", () => {
  assert.equal(pickEmail(["sample@co.jp", "xxx@xxx.xxx", "example@example.net"]), null);
  assert.equal(pickEmail([]), null);
  assert.equal(pickEmail(undefined), null);
});

test("abc.jp のアドレス・画像ファイル名・従来の除外ドメインの扱い", () => {
  assert.equal(pickEmail(["bandotaro@abc.jp"]), "bandotaro@abc.jp", "abc.jp は判定に使わない");
  assert.equal(pickEmail(["logo@2x.png", "info@foo.co.jp"]), "info@foo.co.jp");
  assert.equal(pickEmail(["a@example.com", "b@test.com"]), null);
});

test("従来どおり info@ / contact@ 等を優先し、大文字・空白は正規化する", () => {
  assert.equal(pickEmail(["tanaka@foo.co.jp", " INFO@Foo.co.jp "]), "info@foo.co.jp");
  assert.equal(pickEmail(["tanaka@foo.co.jp", "suzuki@foo.co.jp"]), "tanaka@foo.co.jp");
});
