// api/submit-form.js の送信者プロフィール切り替え・安全装置のテスト。
// lib/db と lib/form-submitter をrequireキャッシュで偽物に差し替え、DB・ブラウザ・ネットワークは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calls = [];
let profiles = {};          // project → sender_profilesの行
let profileTableMissing = false;
let variant = null;
function fakeSql(strings, ...values) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  calls.push({ text, values });
  if (text.includes("FROM sender_profiles")) {
    if (profileTableMissing) return Promise.reject(new Error('relation "sender_profiles" does not exist'));
    return Promise.resolve(profiles[values[0]] ? [profiles[values[0]]] : []);
  }
  if (text.includes("FROM companies")) return Promise.resolve([company()]);
  if (text.includes("FROM message_variants")) return Promise.resolve([variant]);
  if (text.includes("INSERT INTO send_logs")) return Promise.resolve([{ id: 999 }]);
  return Promise.resolve([]);
}

let project = "ozukanzukan";
function company() {
  return {
    id: 1, name: "テスト株式会社", url: "https://example.com", project,
    archived: false, action_status: null, contact_form_url: "https://example.com/contact",
    research_result: {
      automatable: true,
      fieldMapping: [
        { role: "contact_person_name", name: "name" },
        { role: "contact_person_name_kana", name: "kana" },
        { role: "company_name", name: "company" },
        { role: "email", name: "email" },
        { role: "phone", name: "tel" },
        { role: "message", name: "message" },
      ],
    },
  };
}

const submitCalls = [];
function stub(relPath, exports) {
  const p = require.resolve(path.join(__dirname, "..", relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("lib/db", { sql: fakeSql, getSettings: async () => ({}), isExcludedDomain: async () => false });
stub("lib/form-submitter", {
  submitForm: async (url, fieldValues, options) => {
    submitCalls.push({ url, fieldValues, options });
    return { status: "success", resultUrl: url, resultTitle: "", filledFields: [{ role: "contact_person_name", field: "name", label: "お名前", value: options.profile.personName, filled: true }] };
  },
});
const handler = require("../api/submit-form");

function call(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, body: d }); return this; },
    };
    handler({ method: "POST", body }, res);
  });
}

const PROFILE = {
  person_name: "松崎流空",
  person_name_kana: "まつざきりゅうと",
  company_name: "株式会社LOCLE",
  email: "matsuzaki9283@gmail.com",
  phone: "027-212-2117",
};
const SIGNED_BODY = "{{company_name}} ご担当者様\n編集部の松崎と申します。\nぐんまお仕事図鑑編集部　松崎流空";

function reset({ proj = "ozukanzukan", prof = { ozukanzukan: { id: 1, project: "ozukanzukan", ...PROFILE } }, body = SIGNED_BODY, tableMissing = false } = {}) {
  calls.length = 0;
  submitCalls.length = 0;
  project = proj;
  profiles = prof;
  profileTableMissing = tableMissing;
  variant = { id: 7, project: proj, subject_template: "件名", body_template: body };
}
const inserted = () => calls.filter(c => c.text.includes("INSERT INTO send_logs"));

test("プロフィール未登録なら400 sender_profile_missing。フォームを開かず、send_logsにも書かない", async () => {
  reset({ prof: {} });
  const r = await call({ company_id: 1, variant_id: 7 });
  assert.equal(r.status, 400);
  assert.equal(r.body.type, "sender_profile_missing");
  assert.match(r.body.error, /ozukanzukan/);
  assert.match(r.body.error, /未登録/);
  assert.equal(submitCalls.length, 0);
  assert.equal(inserted().length, 0);
});

test("sender_profilesテーブルが無い場合も未登録として止める", async () => {
  reset({ tableMissing: true });
  const r = await call({ company_id: 1, variant_id: 7 });
  assert.equal(r.status, 400);
  assert.equal(r.body.type, "sender_profile_missing");
  assert.equal(submitCalls.length, 0);
  assert.equal(inserted().length, 0);
});

test("プロフィールに空欄・形式不正があれば止める(既定値で送らない)", async () => {
  for (const bad of [{ phone: "" }, { person_name: "　" }, { email: "matsuzaki9283gmail.com" }, { person_name_kana: "松崎" }]) {
    reset({ prof: { ozukanzukan: { id: 1, project: "ozukanzukan", ...PROFILE, ...bad } } });
    const r = await call({ company_id: 1, variant_id: 7 });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.type, "sender_profile_missing");
    assert.match(r.body.error, /不完全/);
    assert.equal(submitCalls.length, 0);
    assert.equal(inserted().length, 0);
  }
});

test("別プロジェクトのプロフィールしか無ければ止める(取り違えない)", async () => {
  reset({ proj: "locle", prof: { ozukanzukan: { id: 1, project: "ozukanzukan", ...PROFILE } } });
  const r = await call({ company_id: 1, variant_id: 7 });
  assert.equal(r.status, 400);
  assert.equal(r.body.type, "sender_profile_missing");
  assert.match(r.body.error, /locle/);
});

test("プロジェクトのプロフィールの値でフォームに入力する(環境変数は使わない)", async () => {
  process.env.SENDER_PERSON_NAME = "山田武蔵";
  process.env.SENDER_COMPANY_NAME = "別の会社";
  try {
    reset({
      proj: "locle",
      prof: {
        ozukanzukan: { id: 1, project: "ozukanzukan", ...PROFILE, person_name: "図鑑太郎" },
        locle: { id: 2, project: "locle", ...PROFILE },
      },
    });
    const r = await call({ company_id: 1, variant_id: 7 });
    assert.equal(r.status, 200);
    assert.equal(submitCalls.length, 1);
    const byRole = Object.fromEntries(submitCalls[0].fieldValues.map(f => [f.role, f.value]));
    assert.equal(byRole.contact_person_name, "松崎流空");
    assert.equal(byRole.contact_person_name_kana, "マツザキリュウト", "既定はカタカナ");
    assert.equal(byRole.company_name, "株式会社LOCLE");
    assert.equal(byRole.email, "matsuzaki9283@gmail.com");
    assert.equal(byRole.phone, "027-212-2117");
    assert.deepEqual(submitCalls[0].options.profile, {
      companyName: "株式会社LOCLE", personName: "松崎流空", personNameKana: "マツザキリュウト",
      email: "matsuzaki9283@gmail.com", phone: "027-212-2117",
    });
    assert.ok(!JSON.stringify(submitCalls[0]).includes("山田武蔵"));
  } finally {
    delete process.env.SENDER_PERSON_NAME;
    delete process.env.SENDER_COMPANY_NAME;
  }
});

test("send_logsに送信者プロフィールID・値の写し・実際の入力値を記録する", async () => {
  reset();
  const r = await call({ company_id: 1, variant_id: 7 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.warnings, []);
  const [ins] = inserted();
  assert.ok(ins.text.includes("sender_profile_id, sender_snapshot, filled_fields"));
  const [profileId, snapshotJson, filledJson] = ins.values.slice(-3);
  assert.equal(profileId, 1);
  assert.deepEqual(JSON.parse(snapshotJson), {
    project: "ozukanzukan", ...PROFILE, body_name_check: "ok",
  });
  assert.deepEqual(JSON.parse(filledJson), [{ role: "contact_person_name", field: "name", label: "お名前", value: "松崎流空", filled: true }]);
});

test("本文の署名が送信者名と違えば警告を返すが、送信は止めない", async () => {
  reset({ body: "LOCLEと申します。\nLOCLE　山田" });
  const r = await call({ company_id: 1, variant_id: 7 });
  assert.equal(r.status, 200);
  assert.equal(submitCalls.length, 1);
  assert.equal(r.body.warnings.length, 1);
  assert.match(r.body.warnings[0], /松崎流空/);
  assert.equal(JSON.parse(inserted()[0].values.slice(-2)[0]).body_name_check, "mismatch");
});
