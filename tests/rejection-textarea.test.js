// リサーチの営業お断りの検出(lib/form-analyzer.js の findRejection)と、AIが本文の欄を見つけなかったときの
// 複数行の欄の補い(fillMessageFromTextarea)、AIに渡す欄の種類(buildAIFieldEntries)のテスト。ブラウザ・DB・外部APIは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { findRejection, fillMessageFromTextarea, buildAIFieldEntries } = require("../lib/form-analyzer");

test("営業お断り: 入力例の「…はご遠慮下さい」(漢字)や「営業目的のメールでない場合は」を検出する", () => {
  for (const s of [
    "お問い合わせ内容をご記入下さい。（営業メールやご提案に関するメールはご遠慮下さい）", // 2204の入力例
    "営業目的のメールでない場合は、チェックをいれて送信してください。", // 2078の確認欄
    "営業のご連絡はお断り致します",
    "セールスのお電話はお断りさせていただきます",
    "勧誘目的のお問い合わせはご遠慮頂きます",
    "このフォームからの営業活動ではありませんか", // 「営業活動」+否定
    "営業のメールではございません",
    // 従来から検出しているもの
    "営業メールではありません",
    "勧誘・広告・セールスを目的とした営業メールは固くお断りいたします",
    "営業のご連絡はご遠慮ください",
  ]) assert.equal(findRejection(s).detected, true, s);
});

test("営業お断り: 「営業部」「営業職」「営業時間」等の普通の文言は一致させない(誤検出しない)", () => {
  for (const s of [
    "営業部", "例）営業部", "営業職", "部門・部署 / 営業部",
    "当社営業内容に関するお問い合わせ", "夜7時以降も営業している会社", "営業員の説明が聞きたい",
    "土日は営業日ではないため、翌営業日に回答します",
    "営業時間ではない場合は翌日のご連絡となります",
    "営業時間外のお電話はご遠慮ください", // 従来は「営業」+「ご遠慮ください」で誤検出していた
    "営業日以外のご来社はご遠慮下さい",
    "営業所への直接のお問い合わせはご遠慮ください",
    "営業部への直接のお電話はご遠慮下さい",
    "お問い合わせ内容をご記入下さい", "ご記入下さい", "広告掲載について",
    "", null,
  ]) assert.equal(findRejection(s).detected, false, String(s));
});

test("営業お断り: 普通の「営業時間」と本物のお断りが両方あれば、お断りとして検出する", () => {
  const r = findRejection("営業時間外のお電話はご遠慮ください。営業目的のご連絡もお断りいたします");
  assert.equal(r.detected, true);
});

const F = (fields) => [{ formIndex: 0, fields }];
const M = (fields, roles) => fields.map((f, i) => ({ formIndex: 0, name: f.name, id: f.id || "", role: roles[i], confidence: "high" }));

test("本文の補い: AIの判定に本文が無く、複数行の欄がちょうど1つなら、それを本文とみなす(確信度は低)", () => {
  // 1986(アートハウス)の形: ラベルの無い textarea をAIが「電話」と判定した
  const fields = [
    { tag: "input", type: "text", name: "element-0" }, { tag: "input", type: "text", name: "element-1" },
    { tag: "input", type: "radio", name: "element-2" }, { tag: "input", type: "radio", name: "element-2" },
    { tag: "input", type: "text", name: "element-3" }, { tag: "textarea", type: "text", name: "element-4" },
  ];
  const r = fillMessageFromTextarea(F(fields), M(fields, ["contact_person_name", "contact_person_name_kana", "other", "other", "email", "phone"]));
  assert.equal(r.usedField, "element-4");
  assert.deepEqual(r.mapping[5], { formIndex: 0, name: "element-4", id: "", role: "message", confidence: "low" });
  assert.equal(r.mapping[0].role, "contact_person_name", "ほかの欄は変えない");
});

test("本文の補い: 本文が既にある・候補が0個/2個以上・わなの欄だけ、の場合は補わない", () => {
  const ta = (name) => ({ tag: "textarea", type: "text", name });
  const name = { tag: "input", type: "text", name: "name" };
  // 本文が既にある
  let fields = [name, ta("msg")];
  assert.equal(fillMessageFromTextarea(F(fields), M(fields, ["contact_person_name", "message"])).usedField, null);
  // 候補が0個
  fields = [name, { tag: "input", type: "text", name: "tel" }];
  assert.equal(fillMessageFromTextarea(F(fields), M(fields, ["contact_person_name", "phone"])).usedField, null);
  // 候補が2個以上(1985の資料請求のように複数の詳細欄がある)は推測しない
  fields = [name, ta("detail1"), ta("detail2")];
  assert.equal(fillMessageFromTextarea(F(fields), M(fields, ["contact_person_name", "other", "other"])).usedField, null);
  // スパム対策のわなの欄は候補にしない
  fields = [name, ta("_wpcf7_ak_hp_textarea")];
  assert.equal(fillMessageFromTextarea(F(fields), M(fields, ["contact_person_name", "other"])).usedField, null);
  // わなの欄 + 本物の欄 → 本物の欄を本文にする
  fields = [name, ta("_wpcf7_ak_hp_textarea"), ta("inquiry")];
  const r = fillMessageFromTextarea(F(fields), M(fields, ["contact_person_name", "other", "other"]));
  assert.equal(r.usedField, "inquiry");
  assert.equal(r.mapping[1].role, "other");
  assert.equal(r.mapping[2].role, "message");
});

test("AIに渡す欄: 複数行の欄(textarea)は種類を textarea として渡す(抜き出した type は text のため)", () => {
  const built = buildAIFieldEntries(F([
    { tag: "input", type: "text", name: "Block9_1[item][7]" },
    { tag: "textarea", type: "text", name: "Block9_1[item][9]" },
    { tag: "select", type: "select", name: "pref" },
  ]));
  assert.deepEqual(built.entries.map((e) => e.type), ["text", "textarea", "select"]);
});
