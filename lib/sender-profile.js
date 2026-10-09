// lib/sender-profile.js
//
// フォーム送信で名乗る送信者情報(名前・ふりがな・会社名・メール・電話)を、プロジェクトごとに
// sender_profilesテーブルで管理する。以前は環境変数1組(SENDER_PERSON_NAME等)をプロジェクトに
// 関係なく使っており、sensitive型で値を誰も確認できないまま別人の名前で送信していたため、
// 画面で値を確認できるDB管理に切り替える。未登録・空欄・形式不正のときは既定値で送らず止める。
// DBクライアントは引数で受け取る(lib/dbはDATABASE_URLが無いと読み込み時に失敗し、テストできないため)

const PROJECTS = ["ozukanzukan", "locle"];

const PROFILE_FIELDS = [
  { key: "person_name",      label: "氏名" },
  { key: "person_name_kana", label: "ふりがな" },
  { key: "company_name",     label: "会社名" },
  { key: "email",            label: "メールアドレス" },
  { key: "phone",            label: "電話番号" },
];

// 前後の空白(全角スペースを含む)を取り除く
function normalizeProfile(input) {
  const p = input || {};
  const out = {};
  for (const { key } of PROFILE_FIELDS) {
    out[key] = typeof p[key] === "string" ? p[key].replace(/^[\s　]+|[\s　]+$/g, "") : "";
  }
  return out;
}

// 必須チェックと形式チェック(入力ミスを保存前に見つけるため)。
// 戻り値: { ok, profile(正規化後), missing: [項目名], invalid: [{ field, reason }] }
function validateProfile(input) {
  const profile = normalizeProfile(input);
  const missing = PROFILE_FIELDS.filter(({ key }) => !profile[key]).map(({ label }) => label);
  const invalid = [];

  if (profile.person_name_kana && !/^[ぁ-ゖァ-ヶー\s　]+$/.test(profile.person_name_kana)) {
    invalid.push({ field: "ふりがな", reason: "ひらがな・カタカナ以外の文字が含まれています" });
  }
  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
    invalid.push({ field: "メールアドレス", reason: "メールアドレスの形式ではありません" });
  }
  if (profile.phone) {
    const digits = profile.phone.replace(/-/g, "");
    if (!/^[0-9-]+$/.test(profile.phone)) {
      invalid.push({ field: "電話番号", reason: "半角数字とハイフン以外の文字が含まれています" });
    } else if (!/^0\d{9,10}$/.test(digits)) {
      invalid.push({ field: "電話番号", reason: "0から始まる10〜11桁の番号ではありません" });
    }
  }

  return { ok: missing.length === 0 && invalid.length === 0, profile, missing, invalid };
}

// バリアント本文(件名+本文)に送信者名が含まれているかの照合。空白は無視して氏名全体で探し、
// 氏名が空白区切り(「松崎 流空」等)なら姓だけでも一致とみなす。署名と送信者名のずれ
// (今回の「山田武蔵」の件のような事故)に気づくための警告用で、結果によって送信は止めない
function checkBodyName(text, profile) {
  const strip = (s) => (s || "").replace(/[\s　]+/g, "");
  const body = strip(text);
  const fullName = strip(profile && profile.person_name);
  if (!fullName) return "mismatch";
  if (body.includes(fullName)) return "ok";
  const parts = ((profile && profile.person_name) || "").trim().split(/[\s　]+/);
  if (parts.length > 1 && parts[0] && body.includes(parts[0])) return "ok";
  return "mismatch";
}

// 送信時にプロジェクトの送信者プロフィールを取得する。未登録ならnull
async function loadSenderProfile(sql, project) {
  const [row] = await sql`
    SELECT id, project, person_name, person_name_kana, company_name, email, phone, updated_at
    FROM sender_profiles WHERE project = ${project}
  `;
  return row || null;
}

module.exports = { PROJECTS, PROFILE_FIELDS, normalizeProfile, validateProfile, checkBodyName, loadSenderProfile };
