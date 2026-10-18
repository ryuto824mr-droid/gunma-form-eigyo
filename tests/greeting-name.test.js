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
    "めん処 酒処 ふる川 暮六つ", "株式会社LeafLink", "阪急阪神ホールディングス株式会社",
    "大森不動産", "森建コーポレーション",
    // 中黒を含む実在の名前・法人格の略記・スペース入りの正式表記・「の」を含む社名はそのまま使える
    "株式会社G・Mフーズ", "（株）住吉製作所", "(株)丸山機械製作所", "株式会社 協和", "株式会社Room’s", "森の工房株式会社", "株式会社AB",
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

test("ひらがなの語＋「は」で始まる説明文は不確か(753 の正式名称がすり抜けた形)", () => {
  for (const name of [
    "しゅんせつはみなしろ建設株式会社",
    "だけではなかなか伝わりづらい",
    "おそうじはクリーン群馬株式会社",
    "いえづくりは山田工務店",
    "株式会社 りふぉーむは高崎建装",
  ]) {
    assert.deepEqual(checkGreetingName(name), { ok: false, reason: "説明文の形(ひらがなの語＋は)" }, name);
  }
  // 753: 正式名称が使えないので、登録名(英字)を宛名にする
  const g = resolveGreetingName({ name: "Minashiro Construction", company_info: { official_name: "しゅんせつはみなしろ建設株式会社" } });
  assert.equal(g.name, "Minashiro Construction");
  assert.equal(g.source, "name");
});

test("「は」を含む実在の形の社名は、これまでどおり宛名に使う(誤検出しない)", () => {
  for (const name of [
    "株式会社このはな", "このはな製作所", "いろは株式会社", "はなまる株式会社", "株式会社まるはち",
    "株式会社ことはじめ", "たかはし建設株式会社", "おおはし工務店", "株式会社みはらし",
    "さくらはうす建設株式会社", "ひかりはうす株式会社", "やすらぎはーと株式会社",
    "あさひはら建設株式会社", "ひがしはま運輸株式会社", "さくらはし工業株式会社", "みどりはやし農園",
    "株式会社ひまわりはなこ", "こはる株式会社", "株式会社 ちはや",
    "株式会社沼田青果", "佐藤産業株式会社", "株式会社高崎イベントサービス", "株式会社G・Mフーズ",
  ]) {
    assert.deepEqual(checkGreetingName(name), { ok: true, reason: null }, name);
  }
});

test("途中で切れた名前・事業の説明・事業所名・括弧つきは不確か(送信待ちに実際に入っていた形)", () => {
  const cases = [
    ["株式会社G", "法人格と1文字だけ(途中で切れた疑い)"],
    ["G株式会社", "法人格と1文字だけ(途中で切れた疑い)"],
    ["樹脂加工の植木プラスチック株式会社", "事業の説明が頭に付いている"],
    ["株式会社阿部製作 本社", "本社・工場などの事業所名が付いている"],
    ["（株）冨士ハム伊勢崎工場", "本社・工場などの事業所名が付いている"],
    ["㈱ティー･エス･ケー 本社工場", "本社・工場などの事業所名が付いている"],
    ["植木プラスチック株式会社 伊勢崎工場", "本社・工場などの事業所名が付いている"],
    ["池田製作所（群馬県太田市）", "括弧つき"],
    ["Farmdo（ファームドゥ）", "括弧つき"],
    ["株式会社Ｒｏｏｍ’ｓ（ルームス）", "括弧つき"],
  ];
  for (const [name, reason] of cases) assert.deepEqual(checkGreetingName(name), { ok: false, reason }, name);
});

test("正式名称が登録名の中黒の直前で切れていたら使わず、登録名を使う(使えなければ「ご担当者様」)", () => {
  const gm = resolveGreetingName({ name: "株式会社G・Mフーズ", company_info: { official_name: "株式会社G" } });
  assert.equal(gm.name, "株式会社G・Mフーズ");
  assert.equal(gm.source, "name");
  const tsk = resolveGreetingName({ name: "㈱ティー･エス･ケー 本社工場", company_info: { official_name: "株式会社ティー" } });
  assert.equal(tsk.name, null);
  assert.deepEqual(tsk.rejected.map((r) => r.reason), ["途中で切れている(登録名では中黒などが続く)", "本社・工場などの事業所名が付いている"]);
  // 切れていない正式名称はそのまま使う(登録名が正式名称で始まっても、続きが中黒でなければ切れていない)
  assert.equal(resolveGreetingName({ name: "株式会社ハヤセ 桐生工場", company_info: { official_name: "株式会社ハヤセ" } }).name, "株式会社ハヤセ");
  assert.equal(resolveGreetingName({ name: "（株）ピーエルエム 群馬工場", company_info: { official_name: "株式会社ピーエルエム" } }).name, "株式会社ピーエルエム");
  const { truncatedAgainst } = require("../lib/greeting-name");
  assert.equal(truncatedAgainst("株式会社ティー", "㈱ティー･エス･ケー"), true);
  assert.equal(truncatedAgainst("株式会社G", "株式会社G・Mフーズ"), true);
  assert.equal(truncatedAgainst("株式会社ハヤセ", "株式会社ハヤセ 桐生工場"), false);
  assert.equal(truncatedAgainst("株式会社ハヤセ", "株式会社ハヤセ"), false);
  assert.equal(truncatedAgainst("", "株式会社G・Mフーズ"), false);
});

test("置き換え: 宛名が不確かになった企業は「ご担当者様」で送る(株式会社G 様 にならない)", () => {
  const c = { name: "㈱ティー･エス･ケー 本社工場", company_info: { official_name: "株式会社ティー" } };
  assert.equal(fillCompanyName("{{company_name}} 様｜群馬の若手10万人に届く採用SNS", c, "subject"), "群馬の若手10万人に届く採用SNS");
  assert.equal(fillCompanyName("{{company_name}} ご担当者様", c, "body"), "ご担当者様");
  const gm = { name: "株式会社G・Mフーズ", company_info: { official_name: "株式会社G" } };
  assert.equal(fillCompanyName("{{company_name}} ご担当者様", gm, "body"), "株式会社G・Mフーズ ご担当者様");
});
