// 画像認証・認証コード等の欄の判定(lib/form-analyzer.js の findImageAuthFields)のテスト。ブラウザ・DB・外部APIは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { findImageAuthFields } = require("../lib/form-analyzer");

const one = (field) => findImageAuthFields([{ formIndex: 0, fields: [{ tag: "input", type: "text", ...field }] }]);

test("画像認証・認証コード等の欄を見つける(欄の名前・ラベル・入力例・近くの文字)", () => {
  for (const f of [
    { name: "data[Block59_2][img_auth]", label: "画像認証 ※必須" }, // 1987
    { name: "Block21_1[img_auth]", label: "" }, // 名前だけ
    { name: "captcha-170", label: "" }, // Contact Form 7 の画像認証
    { name: "captcha", label: "" },
    { name: "form[spamcheck]", label: "" },
    { name: "code", label: "認証コード" },
    { name: "x1", label: "確認コード(半角)" },
    { name: "x2", placeholder: "画像の文字を入力してください" },
    { name: "x3", hint: "上に表示されている文字を入力してください" },
    { name: "securimage_code" }, { name: "verify_code" }, { name: "auth_code" },
    { name: "security_code", label: "" }, { name: "kaptcha" },
  ]) assert.equal(one(f).length, 1, JSON.stringify(f));
});

test("メールの確認の再入力・郵便番号・「確認」「認証」「コード」の1語だけの欄は見つけない(誤検出しない)", () => {
  for (const f of [
    { name: "email2", label: "確認のため再度メールアドレス" },
    { name: "email-check", label: "*メールアドレス確認用" },
    { name: "emailConfirm", label: "メールアドレス（確認用）必須" },
    { name: "email_confirm", label: "確認のためもう一度入力してください" },
    { name: "input2_1", label: "確認のため、再度入力してください" },
    { name: "zipcode", label: "郵便番号" }, { name: "postcode01", label: "" }, { name: "x", label: "〒" },
    { name: "x", label: "確認" }, { name: "x", label: "認証" }, { name: "x", label: "コード" },
    { name: "product_code", label: "製品コード" }, { name: "x", label: "ご確認事項" },
  ]) assert.deepEqual(one(f), [], JSON.stringify(f));
});

test("本文の欄・選択肢・チェックボックス・隠し欄は対象にしない", () => {
  const forms = [{ formIndex: 0, fields: [
    { tag: "textarea", type: "text", name: "body", label: "表示されている文字について" },
    { tag: "select", type: "select", name: "captcha_type", label: "" },
    { tag: "input", type: "checkbox", name: "captcha_agree", label: "画像認証に同意" },
    { tag: "input", type: "hidden", name: "_wpcf7_captcha_challenge_captcha-170", label: "" },
  ] }];
  assert.deepEqual(findImageAuthFields(forms), []);
  assert.deepEqual(findImageAuthFields(undefined), []);
});

test("見つけた欄はラベルがあればラベル、無ければ欄の名前で返す", () => {
  assert.deepEqual(one({ name: "data[Block59_2][img_auth]", label: "画像認証 ※必須" }), ["画像認証 ※必須"]);
  assert.deepEqual(one({ name: "captcha-170", label: "" }), ["captcha-170"]);
});
