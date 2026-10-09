// 送信者プロフィールの検証(lib/sender-profile.js)のテスト。ネットワーク・DBは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProfile, normalizeProfile } = require("../lib/sender-profile");

const PROFILE = {
  person_name: "松崎流空",
  person_name_kana: "まつざきりゅうと",
  company_name: "株式会社LOCLE",
  email: "matsuzaki9283@gmail.com",
  phone: "027-212-2117",
};

test("正しいプロフィールは合格", () => {
  const r = validateProfile(PROFILE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.profile, PROFILE);
});

test("前後の空白(全角スペース含む)は取り除く", () => {
  const r = validateProfile({ ...PROFILE, person_name: "　松崎流空 ", phone: " 027-212-2117\t" });
  assert.equal(r.ok, true);
  assert.equal(r.profile.person_name, "松崎流空");
  assert.equal(r.profile.phone, "027-212-2117");
});

test("5項目すべて必須(空・空白だけ・項目なし)", () => {
  for (const key of Object.keys(PROFILE)) {
    for (const bad of ["", "   ", "　　", undefined, null, 123]) {
      const r = validateProfile({ ...PROFILE, [key]: bad });
      assert.equal(r.ok, false, `${key}=${JSON.stringify(bad)}`);
      assert.equal(r.missing.length, 1, `${key}=${JSON.stringify(bad)}`);
    }
  }
  const r = validateProfile({});
  assert.deepEqual(r.missing, ["氏名", "ふりがな", "会社名", "メールアドレス", "電話番号"]);
  assert.equal(validateProfile(null).ok, false);
});

test("ふりがなの形式", () => {
  assert.equal(validateProfile({ ...PROFILE, person_name_kana: "マツザキリュウト" }).ok, true);
  assert.equal(validateProfile({ ...PROFILE, person_name_kana: "まつざき りゅうと" }).ok, true);
  assert.equal(validateProfile({ ...PROFILE, person_name_kana: "まつざき流空" }).ok, false);
  assert.equal(validateProfile({ ...PROFILE, person_name_kana: "matsuzaki" }).ok, false);
});

test("メールアドレスの形式", () => {
  assert.equal(validateProfile({ ...PROFILE, email: "matsuzaki9283gmail.com" }).ok, false);
  assert.equal(validateProfile({ ...PROFILE, email: "matsuzaki9283@gmail" }).ok, false);
  assert.equal(validateProfile({ ...PROFILE, email: "a b@gmail.com" }).ok, false);
});

test("電話番号の形式", () => {
  assert.equal(validateProfile({ ...PROFILE, phone: "0272122117" }).ok, true);
  assert.equal(validateProfile({ ...PROFILE, phone: "090-1234-5678" }).ok, true);
  assert.equal(validateProfile({ ...PROFILE, phone: "027-212-211" }).ok, false, "9桁");
  assert.equal(validateProfile({ ...PROFILE, phone: "027-212-21177" }).ok, true, "11桁は携帯等の可能性があるため許可");
  assert.equal(validateProfile({ ...PROFILE, phone: "027-212-211777" }).ok, false, "12桁");
  assert.equal(validateProfile({ ...PROFILE, phone: "127-212-2117" }).ok, false, "0始まりでない");
  assert.equal(validateProfile({ ...PROFILE, phone: "０２７-２１２-２１１７" }).ok, false, "全角数字");
  assert.equal(validateProfile({ ...PROFILE, phone: "027ー212ー2117" }).ok, false, "長音記号");
});

test("normalizeProfileは余計な項目を含めない", () => {
  assert.deepEqual(Object.keys(normalizeProfile({ ...PROFILE, project: "locle", id: 1 })),
    ["person_name", "person_name_kana", "company_name", "email", "phone"]);
});

const { checkBodyName } = require("../lib/sender-profile");

test("本文の署名と送信者名の照合", () => {
  const p = { person_name: "松崎流空" };
  assert.equal(checkBodyName("編集部の松崎と申します。\n\nぐんまお仕事図鑑編集部　松崎流空", p), "ok");
  assert.equal(checkBodyName("署名: 松崎 流空", p), "ok", "本文側の空白は無視");
  assert.equal(checkBodyName("編集部の松崎と申します。", p), "mismatch", "姓だけでは一致としない(氏名が空白区切りでないため)");
  assert.equal(checkBodyName("LOCLEについて\n○○担当者\n\nLOCLE　山田", p), "mismatch");
  assert.equal(checkBodyName("LOCLEと申します。どうぞよろしくお願いいたします。", p), "mismatch");
  assert.equal(checkBodyName("松崎と申します", { person_name: "松崎 流空" }), "ok", "空白区切りなら姓だけで一致");
  assert.equal(checkBodyName("松崎流空", { person_name: "" }), "mismatch");
  assert.equal(checkBodyName("", p), "mismatch");
  assert.equal(checkBodyName("松崎流空", null), "mismatch");
});
