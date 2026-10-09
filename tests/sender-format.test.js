// 送信者プロフィールの値の変換(lib/sender-format.js)のテスト。ネットワーク・DBは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  katakanaToHiragana, hiraganaToKatakana, splitPhone, phoneDigits, buildFormPreview,
} = require("../lib/sender-format");

const PROFILE = {
  person_name: "松崎流空",
  person_name_kana: "まつざきりゅうと",
  company_name: "株式会社LOCLE",
  email: "matsuzaki9283@gmail.com",
  phone: "027-212-2117",
};

test("ひらがな→カタカナ", () => {
  assert.equal(hiraganaToKatakana("まつざきりゅうと"), "マツザキリュウト");
  assert.equal(hiraganaToKatakana("マツザキ りゅうと"), "マツザキ リュウト");
  assert.equal(hiraganaToKatakana(""), "");
  assert.equal(hiraganaToKatakana(undefined), "");
});

test("カタカナ→ひらがな", () => {
  assert.equal(katakanaToHiragana("マツザキリュウト"), "まつざきりゅうと");
  assert.equal(katakanaToHiragana("まつざきりゅうと"), "まつざきりゅうと");
});

test("電話番号の3分割", () => {
  assert.deepEqual(splitPhone("027-212-2117"), ["027", "212", "2117"]);
  assert.deepEqual(splitPhone("0272122117"), ["027", "212", "2117"]);
  assert.deepEqual(splitPhone("09012345678"), ["090", "1234", "5678"]);
  assert.equal(splitPhone(""), null);
  assert.equal(splitPhone("12345"), null);
});

test("電話番号の数字だけ版", () => {
  assert.equal(phoneDigits("027-212-2117"), "0272122117");
});

test("プレビューが計画どおりの値になる", () => {
  const rows = Object.fromEntries(buildFormPreview(PROFILE).map(r => [r.field, r.value]));
  assert.deepEqual(rows, {
    "お名前・氏名・ご担当者名": "松崎流空",
    "ふりがな・よみがな": "まつざきりゅうと",
    "フリガナ・カナ・ふりがな(カタカナ)・ラベルなし": "マツザキリュウト",
    "会社名・貴社名": "株式会社LOCLE",
    "メールアドレス・確認用メールアドレス": "matsuzaki9283@gmail.com",
    "電話番号(1つの欄)": "027-212-2117",
    "電話番号(ハイフンなし指定・数値の欄・最大文字数が足りない欄)": "0272122117",
    "電話番号(3分割)": "027 / 212 / 2117",
  });
});

test("ふりがなをカタカナで登録してもプレビューは同じ", () => {
  const a = buildFormPreview(PROFILE);
  const b = buildFormPreview({ ...PROFILE, person_name_kana: "マツザキリュウト" });
  assert.deepEqual(a, b);
});
