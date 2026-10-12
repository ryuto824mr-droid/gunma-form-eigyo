// ラベルの無い欄の推測の判定(lib/form-analyzer.js の findUnlabeledGuesses)のテスト。ブラウザ・DB・外部APIは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { findUnlabeledGuesses } = require("../lib/form-analyzer");

const F = (fields) => [{ formIndex: 0, fields }];
const M = (fields, roles) => fields.map((f, i) => ({ formIndex: 0, name: f.name, id: f.id || "", role: roles[i], confidence: "medium" }));

test("ラベルの無い欄に名前・ふりがな・会社名・メール・電話を割り当てたら要確認", () => {
  const fields = [
    { tag: "input", type: "text", name: "Block9_1[item][1]", label: "" },
    { tag: "input", type: "text", name: "Block9_1[item][7]", label: "" },
    { tag: "input", type: "text", name: "x3", label: "" },
    { tag: "input", type: "text", name: "x4", label: "" },
    { tag: "input", type: "text", name: "x5", label: "" },
  ];
  assert.deepEqual(
    findUnlabeledGuesses(F(fields), M(fields, ["company_name", "contact_person_name", "contact_person_name_kana", "email", "phone"])),
    ["Block9_1[item][1]=会社名", "Block9_1[item][7]=名前", "x3=ふりがな", "x4=メール", "x5=電話"],
  );
});

test("ラベルがある欄・欄の名前や種類で分かる欄・本文や住所等は要確認にしない", () => {
  const fields = [
    { tag: "input", type: "text", name: "Block9_1[item][7]", label: "電話番号" }, // ラベルあり
    { tag: "input", type: "email", name: "x1", label: "" }, // type=email
    { tag: "input", type: "tel", name: "x2", label: "" }, // type=tel
    { tag: "input", type: "text", name: "your-name", label: "" }, // 欄の名前で分かる
    { tag: "input", type: "text", name: "company", label: "" },
    { tag: "input", type: "text", name: "x6", label: "", placeholder: "例：山田太郎" }, // placeholder はラベル扱い(抜き出し時に label に入る)
    { tag: "textarea", type: "text", name: "body", label: "" }, // 本文は対象外
    { tag: "input", type: "text", name: "addr", label: "" }, // 住所は対象外
  ];
  fields[5].label = "例：山田太郎";
  const roles = ["phone", "email", "phone", "contact_person_name", "company_name", "contact_person_name", "message", "address"];
  assert.deepEqual(findUnlabeledGuesses(F(fields), M(fields, roles)), []);
});

test("欄と項目対応の並びが合わない場合は判定しない(誤って要確認にしない)", () => {
  const fields = [{ tag: "input", type: "text", name: "a", label: "" }];
  assert.deepEqual(findUnlabeledGuesses(F(fields), [{ formIndex: 0, name: "b", role: "email" }]), []);
  assert.deepEqual(findUnlabeledGuesses([], []), []);
  assert.deepEqual(findUnlabeledGuesses(undefined, undefined), []);
});

// 欄の名前の辞書(要確認の判定にだけ使う)。1欄ずつ判定する
const one = (field, role) => findUnlabeledGuesses(F([{ tag: "input", type: "text", label: "", ...field }]), [{ formIndex: 0, name: field.name, id: field.id || "", role }]);

test("辞書: 欄の名前(ローマ字・カナ・漢字)から役割が分かる欄は「推測」にしない", () => {
  for (const [name, role] of [
    ["namae", "contact_person_name"], ["shimei", "contact_person_name"], ["sei", "contact_person_name"], ["mei", "contact_person_name"],
    ["name_sei", "contact_person_name"], ["tantousha", "contact_person_name"], ["お名前", "contact_person_name"],
    ["furigana", "contact_person_name_kana"], ["your-name-furi", "contact_person_name_kana"], ["セイ", "contact_person_name_kana"],
    ["メイ", "contact_person_name_kana"], ["read_1", "contact_person_name_kana"], ["yomi", "contact_person_name_kana"],
    ["kigyoumei", "company_name"], ["kigyou-mame", "company_name"], ["organization", "company_name"], ["conpany", "company_name"],
    ["御社名", "company_name"], ["貴社名", "company_name"], ["meisyou", "company_name"], ["CORP", "company_name"],
    ["replyto", "email"], ["reply-to", "email"], ["e-mail", "email"],
    ["denwa", "phone"], ["keitai", "phone"], ["tel1", "phone"],
  ]) assert.deepEqual(one({ name }, role), [], `${name}=${role}`);
  assert.deepEqual(one({ name: "x9", id: "セイ" }, "contact_person_name_kana"), [], "id でも判定する");
});

test("辞書: ラベルも名前も手がかりが無い欄は、これまでどおり要確認", () => {
  for (const [name, role] of [
    ["item1", "company_name"], ["Block9_1[item][7]", "contact_person_name"], ["data[Block9_1][item][7]", "phone"],
    ["col__883__1__0__0", "company_name"], ["121407", "contact_person_name"], ["data[user][form_8]", "email"],
    ["f_35", "company_name"], ["text-90", "contact_person_name"], ["element-1", "email"], ["", "contact_person_name"],
    ["to", "email"], ["gyousyou", "company_name"], ["name2", "contact_person_name_kana"],
  ]) assert.equal(one({ name }, role).length, 1, `${name}=${role}`);
});

test("辞書: 別の意味の欄を、辞書の語に一致したからといって「名前から分かる」扱いにしない(誤検出しない)", () => {
  for (const [name, role] of [
    ["seikyu", "contact_person_name"], // 請求
    ["seibetsu", "contact_person_name"], // 性別
    ["meishi", "contact_person_name"], // 名刺(mei を含むが単語ではない)
    ["hotel", "phone"], // tel を含む
    ["fax", "phone"], ["fax_tel", "phone"], // FAX は電話ではない
    ["mailmagazine", "email"], ["mail_maga", "email"], // メルマガの申込
    ["kaisha_url", "company_name"], ["company_hp", "company_name"], // 会社のURL
    ["company_address", "company_name"], ["kaisha_zip", "company_name"], // 会社の住所
    ["company_kana", "company_name"], // 会社名のふりがな(会社名ではない)
    ["kana_sei", "contact_person_name"], // 姓のふりがな(名前ではない)
  ]) assert.equal(one({ name }, role).length, 1, `${name}=${role} は要確認のまま`);
});

test("辞書: 表記の揺れ(namekana・tell・telnumbar・姓(必須))も名前から分かる欄として扱い、「名称」等は名前にしない", () => {
  for (const [name, role] of [
    ["namekana", "contact_person_name_kana"], ["tell", "phone"], ["telnumbar[data][0]", "phone"], ["telno", "phone"],
    ["姓(必須)", "contact_person_name"], ["名(必須)", "contact_person_name"],
  ]) assert.deepEqual(one({ name }, role), [], `${name}=${role}`);
  for (const [name, role] of [["名称", "contact_person_name"], ["名刺", "contact_person_name"], ["telop", "phone"]]) {
    assert.equal(one({ name }, role).length, 1, `${name}=${role} は要確認のまま`);
  }
});
