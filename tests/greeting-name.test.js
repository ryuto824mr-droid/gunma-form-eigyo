// 宛名(企業名)の判定と置き換え(lib/greeting-name.js)、正式名称の取り出し(lib/company-info-extractor.js の
// findLegalEntityName)、「あとで送る」の警告(lib/later-status.js)のテスト。DB・ブラウザ・外部APIは使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkGreetingName, resolveGreetingName, fillCompanyName } = require("../lib/greeting-name");
const { findLegalEntityName } = require("../lib/company-info-extractor");
const { buildLaterList } = require("../lib/later-status");

test("宛名として使えない名前(送信済みの38社で実際に使われた壊れた宛名の型)", () => {
  for (const n of [
    "株式会社は損害保険", "株式会社へ", "株式会社のウェブサイトです", "株式会社の紹介", "株式会社", "有限会社",
    "群馬県のおすすめシステム開発会社12選【2024年最新版】｜PRONIアイミツ",
    "「農業、林業、漁業」の検索結果 - 事業承継マッチングプラットフォーム relay",
    "engine 【シャアオフィス/コワーキングルーム/勉強室】", "あっとホーム｜太田市のアパート・賃貸マンション",
    "群馬県太田市の不動産｜大森不動産", "太田市 の会社概要とプレスリリース", "高崎市の不動産情報を探すなら不動産のアクト",
    "藤岡市の不動産情報はベストハウス株式会社", "屋根工事は上毛産業株式会社", "を変更します",
    "Akagi south foothills Forestry Association", "株式会社公式サイト", "株式会社高崎工業の会社概要",
    "トップページ", "System", "株式会社 群協製作所: HOME", "", null,
  ]) assert.equal(checkGreetingName(n).ok, false, String(n));
});

test("宛名として使える名前(本番の実在の企業名の例)", () => {
  for (const n of [
    "群馬総合保険株式会社", "株式会社ジーシーシー", "有限会社多胡設計", "社会福祉法人 愛友会 妙義もみじ学園",
    "Tomioka Silk Mill Clinic", "株式会社桐生タイムス社", "中央労働金庫 高崎ローンセンター", "株式会社情報通信総合研究所",
    "Farmdo（ファームドゥ）", "めん処 酒処 ふる川 暮六つ", "株式会社LeafLink", "阪急阪神ホールディングス株式会社",
    "大森不動産", "森建コーポレーション",
  ]) assert.equal(checkGreetingName(n).ok, true, n);
});

test("正式名称 → 登録名の順に使える方を選び、どちらも使えなければ null", () => {
  assert.deepEqual(resolveGreetingName({ name: "群馬総合保険", company_info: { official_name: "群馬総合保険株式会社" } }).name, "群馬総合保険株式会社");
  const r = resolveGreetingName({ name: "株式会社ジーシーシー", company_info: { official_name: "株式会社" } });
  assert.equal(r.name, "株式会社ジーシーシー");
  assert.equal(r.source, "name");
  assert.deepEqual(r.rejected, [{ value: "株式会社", reason: "法人格だけ" }]);
  const none = resolveGreetingName({ name: "群馬総合保険株式会社は損害保険・生命保険を幅広く", company_info: { official_name: "株式会社は損害保険" } });
  assert.equal(none.name, null);
  assert.equal(none.rejected.length, 2);
});

const SUBJECT = "{{company_name}} 様｜群馬の若手10万人に届く採用SNS";
const BODY = "{{company_name}} ご担当者様\n\nはじめまして。{{company_name}}の採用ご担当者様にご案内です。";

test("置き換え: 使える名前があれば従来どおり名前を入れる", () => {
  const c = { name: "群馬総合保険", company_info: { official_name: "群馬総合保険株式会社" } };
  assert.equal(fillCompanyName(SUBJECT, c, "subject"), "群馬総合保険株式会社 様｜群馬の若手10万人に届く採用SNS");
  assert.equal(fillCompanyName(BODY, c, "body"), "群馬総合保険株式会社 ご担当者様\n\nはじめまして。群馬総合保険株式会社の採用ご担当者様にご案内です。");
});

test("置き換え: 使える名前が無ければ、件名は「様|」まで外し、本文は「ご担当者様」、それ以外は「貴社」", () => {
  const c = { name: "群馬総合保険株式会社は損害保険・生命保険を幅広く", company_info: { official_name: "株式会社は損害保険" } };
  assert.equal(fillCompanyName(SUBJECT, c, "subject"), "群馬の若手10万人に届く採用SNS");
  assert.equal(fillCompanyName(BODY, c, "body"), "ご担当者様\n\nはじめまして。貴社の採用ご担当者様にご案内です。");
  assert.equal(fillCompanyName("{{company_name}}ご担当者様", c, "body"), "ご担当者様");
  assert.equal(fillCompanyName("", c, "subject"), "");
  assert.equal(fillCompanyName(null, c, "body"), "");
});

test("正式名称の取り出し: 法人格の直後が助詞なら前の名前を使い、法人格だけは採らない", () => {
  assert.equal(findLegalEntityName("群馬総合保険株式会社は損害保険・生命保険を"), "群馬総合保険株式会社");
  assert.equal(findLegalEntityName("大同不動産株式会社へのお問い合わせ"), "大同不動産株式会社");
  assert.equal(findLegalEntityName("株式会社ジーシーシー"), "株式会社ジーシーシー");
  assert.equal(findLegalEntityName("© 2024 株式会社高崎工業 All Rights"), "株式会社高崎工業");
  assert.equal(findLegalEntityName("上毛産業株式会社"), "上毛産業株式会社");
  assert.equal(findLegalEntityName("株式会社"), null);
  assert.equal(findLegalEntityName("株式会社へようこそ"), null);
  assert.equal(findLegalEntityName("株式会社のウェブサイトです"), null);
});

test("あとで送る: 宛名が不確かな企業の未送信の行に、赤い警告を出す", () => {
  const c = (id, name, official) => ({ id, name, official_name: official, url: `https://x${id}.jp/`, contact_form_url: `https://x${id}.jp/c`, status: "researched", archived: false, action_status: "none", project: "ozukanzukan", automatable: "true", rejection_detected: "false" });
  const r = buildLaterList({
    companies: [c(2267, "群馬総合保険株式会社は損害保険・生命保険を幅広く", "株式会社は損害保険"), c(1941, "株式会社 ジーシーシー", "株式会社")],
    sendLogSummary: [], queueRows: [], scheduledRows: [], senderProfileValid: true, now: Date.parse("2026-10-14T00:00:00Z"),
  });
  const w = (id) => r.items.find((it) => it.company_id === id).warnings.find((x) => x.code === "greeting_uncertain");
  assert.equal(w(2267).level, "danger");
  assert.match(w(2267).message, /送ると「ご担当者様」だけになります/);
  assert.equal(w(1941), undefined, "登録名が使えれば警告しない");
});
