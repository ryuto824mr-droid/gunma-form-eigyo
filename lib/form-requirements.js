// lib/form-requirements.js
//
// リサーチ(lib/form-analyzer.js)で、問い合わせフォームとして扱ってよいか・自動送信できるかを決める判定。
//
// 以前は、サイト内検索の欄(「検索」「キーワードを入力」「q」等)を問い合わせフォームと誤認して
// 「自動送信できる」と記録することがあった(2026-10時点で自動送信できる扱いの212社中、本文の欄が
// 無いものが50社。送信時にはsubmit-formが「必須項目が入力できない」として送信前に中止するため
// 実害は無かったが、送信待ちに積まれるたびに必ず失敗していた)。
//   1. 検索欄らしいフォームを候補から除く(isSearchLikeForm)
//   2. 送信時と同じ必須の欄(本文 + 会社名かお名前)がそろわないフォームは自動送信不可にする
//      (missingRequiredRoles)

// 自動送信に必要な欄。lib/form-submitter.js の REQUIRED_ROLE_GROUPS(送信前に確かめている条件)と同じ。
// 各グループのうちどれか1つの役割が項目対応にあれば満たす
const REQUIRED_ROLE_GROUPS = [
  { roles: ["message"], label: "本文" },
  { roles: ["company_name", "contact_person_name"], label: "会社名・お名前" },
];

// 項目対応(fieldMapping)にそろっていない必須の欄の名前(例: ["本文"])。そろっていれば空配列
function missingRequiredRoles(fieldMapping) {
  const roles = new Set((fieldMapping || []).map((m) => m && m.role).filter(Boolean));
  return REQUIRED_ROLE_GROUPS.filter((g) => !g.roles.some((r) => roles.has(r))).map((g) => g.label);
}

// 検索欄でよく使われる name/id
const SEARCH_NAME_RE = /^(s|q|k|kw|query|keyword|keywords|search|search_?query|search_?word|searchword|word|freeword|sl|tl|fwt)$/i;
// 検索欄のラベル・入力例でよく使われる語(FAQ・チャットの「質問を入力してください」も含む)
const SEARCH_TEXT_RE = /検索|キーワード|フリーワード|search|調べたい|質問を入力|お困りですか/i;
// 問い合わせフォームらしさを示す欄(これがあれば検索欄とは判定しない)
const CONTACT_FIELD_RE = /mail|メール|tel|phone|電話|お名前|氏名|名前|name|会社|company|御社|貴社/i;

const textLikeField = (f) => {
  const type = String(f.type || "").toLowerCase();
  return f.tag !== "select" && !["checkbox", "radio", "select", "file"].includes(type);
};

// form: extractFormsInBrowserContext が返す形({ fields: [{ tag, type, name, id, label, placeholder }] })
function isSearchLikeForm(form) {
  const fields = (form && form.fields) || [];
  if (fields.length === 0) return false;
  // 本文を書く欄(textarea)があるフォームは検索欄ではない
  if (fields.some((f) => f.tag === "textarea")) return false;
  // メール・電話・お名前・会社名らしい欄があれば問い合わせフォームとみなす
  // (ラベルに「キーワード」を含む欄がたまたまある本物のフォームを除かないため)
  if (fields.some((f) => String(f.type || "").toLowerCase() === "email" ||
      CONTACT_FIELD_RE.test(`${f.name || ""} ${f.id || ""}`) ||
      (textLikeField(f) && CONTACT_FIELD_RE.test(`${f.label || ""} ${f.placeholder || ""}`) && !SEARCH_TEXT_RE.test(`${f.label || ""} ${f.placeholder || ""}`)))) {
    return false;
  }
  const textFields = fields.filter(textLikeField);
  if (textFields.length === 0 || textFields.length > 3) return false;
  return textFields.some((f) =>
    String(f.type || "").toLowerCase() === "search" ||
    SEARCH_NAME_RE.test(f.name || "") ||
    SEARCH_NAME_RE.test(f.id || "") ||
    SEARCH_TEXT_RE.test(`${f.label || ""} ${f.placeholder || ""}`));
}

module.exports = { REQUIRED_ROLE_GROUPS, missingRequiredRoles, isSearchLikeForm };
