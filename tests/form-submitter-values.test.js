// lib/form-submitter.js の欄ごとの入力値(ふりがな・電話番号)のテスト。ブラウザは起動しない
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveNameValue, resolvePhoneValue } = require("../lib/form-submitter");

// api/submit-form.jsが渡すのと同じ形(ふりがなはカタカナ)
const PROFILE = {
  companyName: "株式会社LOCLE", personName: "松崎流空", personNameKana: "マツザキリュウト",
  email: "matsuzaki9283@gmail.com", phone: "027-212-2117",
};
const kanaField = (extra = {}) => ({ role: "contact_person_name_kana", name: "kana", value: "マツザキリュウト", ...extra });
const label = (visible, attrs = "kana", extra = {}) => ({ visible, attrs, ...extra });

test("ふりがな: ラベルがひらがな指定ならひらがな", () => {
  for (const v of ["ふりがな", "ふりがな ※必須", "よみがな", "お名前(ひらがな)"]) {
    assert.equal(resolveNameValue(kanaField(), label(v), PROFILE), "まつざきりゅうと", v);
  }
});

test("ふりがな: フリガナ・カナ・カタカナ指定はカタカナ", () => {
  for (const v of ["フリガナ", "カナ", "ふりがな(カタカナ)", "ふりがな（全角カタカナ）", "お名前（カナ）", "ﾌﾘｶﾞﾅ"]) {
    assert.equal(resolveNameValue(kanaField(), label(v), PROFILE), "マツザキリュウト", v);
  }
});

test("ふりがな: ラベルが無い欄はカタカナ", () => {
  // 表示ラベルもname/id属性も無い(判定材料なし)
  assert.equal(resolveNameValue(kanaField(), label("", ""), PROFILE), "マツザキリュウト");
  // 表示ラベルは無く、name属性がふりがなを示さない(name="field3")
  assert.equal(resolveNameValue(kanaField({ name: "field3" }), label("", "field3"), PROFILE), "マツザキリュウト");
  // 表示ラベルは無く、name属性だけがカナを示す(name="user_kana")
  assert.equal(resolveNameValue(kanaField({ name: "user_kana" }), label("", "user_kana"), PROFILE), "マツザキリュウト");
});

test("ふりがな: 送信者情報がひらがなのまま渡されても、ラベルなしの欄はカタカナにする", () => {
  const field = kanaField({ value: "まつざきりゅうと" });
  assert.equal(resolveNameValue(field, label("", ""), { ...PROFILE, personNameKana: "まつざきりゅうと" }), "マツザキリュウト");
  assert.equal(resolveNameValue(field, label("ふりがな"), { ...PROFILE, personNameKana: "まつざきりゅうと" }), "まつざきりゅうと");
  assert.equal(resolveNameValue(field, label("フリガナ"), { ...PROFILE, personNameKana: "まつざきりゅうと" }), "マツザキリュウト");
});

test("お名前欄にふりがなが割り当てられていたら氏名を入れる(既存の補正)", () => {
  assert.equal(resolveNameValue(kanaField(), label("お名前", "name"), PROFILE), "松崎流空");
});

test("会社名の欄は変えない", () => {
  const f = { role: "company_name", name: "company", value: "株式会社LOCLE" };
  assert.equal(resolveNameValue(f, label("会社名", "company"), PROFILE), "株式会社LOCLE");
});

const phoneField = { role: "phone", name: "tel", value: "027-212-2117" };
test("電話番号: 通常の欄はハイフン付き", () => {
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "tel", pattern: "", maxLength: -1 }), PROFILE), "027-212-2117");
  assert.equal(resolvePhoneValue(phoneField, label("電話番号(ハイフンあり)", "tel", { type: "text", maxLength: 20 }), PROFILE), "027-212-2117");
  assert.equal(resolvePhoneValue(phoneField, label("", "", {}), PROFILE), "027-212-2117");
});

test("電話番号: ハイフンなし指定のラベルは数字のみ", () => {
  for (const v of ["電話番号（ハイフンなし）", "電話番号 ハイフン不要", "TEL(ハイフンを入れずに入力)", "電話番号（-なし）", "電話番号(半角数字のみ)", "電話番号 ※ハイフン抜き"]) {
    assert.equal(resolvePhoneValue(phoneField, label(v, "tel", { type: "text", maxLength: -1 }), PROFILE), "0272122117", v);
  }
});

test("電話番号: type=number・pattern・最大文字数で数字のみ", () => {
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "number", maxLength: -1 }), PROFILE), "0272122117");
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "tel", pattern: "\\d{10,11}", maxLength: -1 }), PROFILE), "0272122117");
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "tel", pattern: "[0-9]+", maxLength: -1 }), PROFILE), "0272122117");
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "tel", pattern: "[0-9-]+", maxLength: -1 }), PROFILE), "027-212-2117", "ハイフンを許すpattern");
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "tel", pattern: "[", maxLength: -1 }), PROFILE), "027-212-2117", "解釈できないpatternは無視");
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "tel", maxLength: 11 }), PROFILE), "0272122117");
  assert.equal(resolvePhoneValue(phoneField, label("電話番号", "tel", { type: "tel", maxLength: 12 }), PROFILE), "027-212-2117");
});

test("電話番号以外の欄は変えない", () => {
  const f = { role: "email", name: "email", value: "matsuzaki9283@gmail.com" };
  assert.equal(resolvePhoneValue(f, label("メール（ハイフンなし）", "email", { type: "number" }), PROFILE), "matsuzaki9283@gmail.com");
});
