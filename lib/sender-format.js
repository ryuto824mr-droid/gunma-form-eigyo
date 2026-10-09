// lib/sender-format.js
//
// 送信者プロフィール(sender_profiles)の値を、フォームの欄の種類ごとの入力値に変換する処理。
// 設定画面のプレビュー(api/crm.js?action=sender-profiles)と実際のフォーム送信
// (lib/form-submitter.js)の両方からこのファイルを使い、プレビューと実際の入力値がずれないようにする。
// ブラウザ側では動かさない(プレビューはサーバーで計算して返す)

function katakanaToHiragana(s) {
  return (s || "").replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function hiraganaToKatakana(s) {
  return (s || "").replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

// 電話番号を3分割する(ハイフン区切りを優先。ハイフンが無い場合は桁数から推定)
function splitPhone(phone) {
  if (!phone) return null;
  const hyphenParts = phone.split(/[-‐－ー―]/).map((s) => s.trim()).filter(Boolean);
  if (hyphenParts.length === 3) return hyphenParts;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) return [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7)];
  if (digits.length === 10) return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  return null;
}

// 「ハイフンなし」指定の欄・type="number"の欄などに入れる、数字だけの電話番号
function phoneDigits(phone) {
  return (phone || "").replace(/\D/g, "");
}

// 設定画面に表示する「フォームに実際に入る値」の一覧。profileはsender_profilesの行と同じ形
// ({ person_name, person_name_kana, company_name, email, phone })
function buildFormPreview(profile) {
  const p = profile || {};
  const parts = splitPhone(p.phone);
  return [
    { field: "お名前・氏名・ご担当者名", value: p.person_name || "" },
    { field: "ふりがな・よみがな", value: katakanaToHiragana(p.person_name_kana) },
    { field: "フリガナ・カナ・ふりがな(カタカナ)・ラベルなし", value: hiraganaToKatakana(p.person_name_kana) },
    { field: "会社名・貴社名", value: p.company_name || "" },
    { field: "メールアドレス・確認用メールアドレス", value: p.email || "" },
    { field: "電話番号(1つの欄)", value: p.phone || "" },
    { field: "電話番号(ハイフンなし指定・数値の欄・最大文字数が足りない欄)", value: phoneDigits(p.phone) },
    { field: "電話番号(3分割)", value: parts ? parts.join(" / ") : "(3分割できません)" },
  ];
}

module.exports = { katakanaToHiragana, hiraganaToKatakana, splitPhone, phoneDigits, buildFormPreview };
