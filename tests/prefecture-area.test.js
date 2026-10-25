// 群馬県以外の会社・施設を外す対策のテスト:
//   lib/prefecture.js(住所から都道府県を見分ける)・lib/company-info-extractor.js(会社概要の住所)・
//   lib/places-search.js(Google Places の結果の住所・施設の種類)。
// Google Places は global.fetch を偽物に差し替えて呼ばない。ブラウザ・DBも使わない
const test = require("node:test");
const assert = require("node:assert/strict");
const { prefectureOf, extractAddress, prefectureBlockReason } = require("../lib/prefecture");
const { extractInfoFromText, mergeInfo } = require("../lib/company-info-extractor");
const { searchPlacesAPI, excludedPlaceType, outsidePrefecture, PLACES_FIELD_MASK } = require("../lib/places-search");

test("住所から都道府県を見分ける", () => {
  assert.equal(prefectureOf("群馬県高崎市八島町1-1"), "群馬県");
  assert.equal(prefectureOf("日本、〒515-0332 三重県多気郡明和町馬之上945"), "三重県");
  assert.equal(prefectureOf("東京都千代田区丸の内"), "東京都");
  assert.equal(prefectureOf("前橋市大手町1-1"), null, "県の書かれていない住所は判定しない");
  assert.equal(prefectureOf(""), null);
  assert.equal(prefectureOf(null), null);
});

test("会社概要の文字から住所を取り出す(見出し・郵便番号)", () => {
  const cases = [
    ["会社名 株式会社テスト\n所在地 〒370-0001 群馬県高崎市中尾町100\nTEL 027-000-0000", "群馬県", "群馬県高崎市中尾町100"],
    ["本社所在地：長野県長野市若槻東条572-1", "長野県", "長野県長野市若槻東条572-1"],
    ["住所\n滋賀県草津市西大路町1-1", "滋賀県", "滋賀県草津市西大路町1-1"],
    ["お問い合わせ先 〒379-1301 群馬県利根郡みなかみ町後閑318", "群馬県", "群馬県利根郡みなかみ町後閑318"],
    ["Address: 〒515-0332 三重県多気郡明和町馬之上945", "三重県", "三重県多気郡明和町馬之上945"],
  ];
  for (const [text, pref, address] of cases) {
    assert.deepEqual(extractAddress(text), { address, prefecture: pref }, text);
  }
});

test("住所が見つからない・県が書かれていない場合は null(県外とはみなさない)", () => {
  for (const text of [
    "所在地 前橋市大手町1-1",
    "群馬県のみなさまに愛されて50年。", // 見出しも郵便番号も無い
    "当社は群馬県を中心に営業しています。\nTEL 027-000-0000",
    "",
  ]) {
    assert.equal(extractAddress(text), null, text);
  }
});

test("本社が県外でも、群馬県内の工場・事業所の住所が載っていれば群馬県の住所を選ぶ(冨士ハム・日本製線の形)", () => {
  assert.deepEqual(
    extractAddress("本社 〒140-0002 東京都品川区東品川3-2-16\n伊勢崎工場 〒372-0000 群馬県伊勢崎市1-1"),
    { address: "群馬県伊勢崎市1-1", prefecture: "群馬県" });
  assert.deepEqual(
    extractAddress("本社所在地 東京都港区新橋2丁目20番15号\n前橋工場 群馬県前橋市鳥羽町1"),
    { address: "群馬県前橋市鳥羽町1", prefecture: "群馬県" });
  // 群馬県内の住所が無ければ、最初の住所(県外)を返す
  assert.equal(extractAddress("本社 長野県長野市1-1\n営業所 新潟県新潟市2-2").prefecture, "長野県");
});

test("文の中の県名は住所とみなさない(植木プラスチックの「群馬県知事より表彰」の形)", () => {
  assert.equal(extractAddress("本社では、群馬県知事より表彰されました。"), null);
  assert.equal(extractAddress("住所の変更について: 弊社は長野県から移転しました"), null);
});

test("会社概要: トップの住所が県外で、会社概要ページに群馬県の住所があれば置き換える", () => {
  const info = { address: null, prefecture: null };
  mergeInfo(info, extractInfoFromText("本社所在地 東京都品川区東品川3-2-16"));
  mergeInfo(info, extractInfoFromText("群馬工場 〒370-0000 群馬県高崎市1-1"));
  assert.deepEqual([info.prefecture, info.address], ["群馬県", "群馬県高崎市1-1"]);
});

test("会社概要: 住所と県を組で取り出し、トップと会社概要ページで混ぜない", () => {
  const top = extractInfoFromText("所在地 群馬県太田市新田町1\n資本金 1000万円");
  assert.equal(top.prefecture, "群馬県");
  assert.equal(top.address, "群馬県太田市新田町1");
  const info = { address: null, prefecture: null };
  mergeInfo(info, top);
  mergeInfo(info, extractInfoFromText("本社所在地 東京都港区1-1"));
  assert.deepEqual([info.prefecture, info.address], ["群馬県", "群馬県太田市新田町1"], "先に見つかった住所を使う");
});

test("リサーチ: 会社概要の住所の県が群馬県以外なら自動送信不可の理由を返す。群馬県・不明なら返さない", () => {
  assert.match(prefectureBlockReason({ prefecture: "長野県", address: "長野県長野市若槻東条572-1" }), /群馬県ではない\(長野県: 長野県長野市/);
  assert.match(prefectureBlockReason({ prefecture: "三重県", address: null }), /群馬県ではない\(三重県\)/);
  assert.equal(prefectureBlockReason({ prefecture: "群馬県", address: "群馬県高崎市" }), null);
  assert.equal(prefectureBlockReason({ prefecture: null, address: null }), null);
  assert.equal(prefectureBlockReason(null), null);
});

test("Places: 群馬県以外の住所と、郵便局・役所・コンビニ・スーパー等の施設の種類を見分ける", () => {
  assert.equal(outsidePrefecture({ formattedAddress: "日本、〒515-0332 三重県多気郡明和町馬之上945" }, "群馬県"), true);
  assert.equal(outsidePrefecture({ formattedAddress: "日本、〒370-0000 群馬県高崎市" }, "群馬県"), false);
  assert.equal(outsidePrefecture({}, "群馬県"), false, "住所が無ければ外さない");
  assert.equal(outsidePrefecture({ formattedAddress: "日本、〒515-0332 三重県多気郡明和町" }, ""), false, "検索の県が無ければ外さない");
  assert.equal(excludedPlaceType({ primaryType: "post_office" }), "post_office");
  assert.equal(excludedPlaceType({ types: ["convenience_store", "store", "point_of_interest"] }), "convenience_store");
  assert.equal(excludedPlaceType({ types: ["supermarket", "grocery_store"] }), "supermarket");
  assert.equal(excludedPlaceType({ primaryType: "local_government_office" }), "local_government_office");
  for (const p of [{ primaryType: "hospital" }, { types: ["general_contractor", "point_of_interest"] }, { types: ["store"] }, {}]) {
    assert.equal(excludedPlaceType(p), null, JSON.stringify(p));
  }
});

test("Places: 住所・施設の種類・日本語で受け取り、群馬県以外と郵便局・コンビニ等を外す(外部には送らない)", async () => {
  const savedFetch = global.fetch;
  const savedKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  let sent = null;
  global.fetch = async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return {
      ok: true, status: 200,
      json: async () => ({
        places: [
          { displayName: { text: "株式会社群馬建設" }, websiteUri: "https://gunma-kensetsu.example.jp/", formattedAddress: "日本、〒370-0001 群馬県高崎市中尾町1", types: ["general_contractor"] },
          { displayName: { text: "明和町役場" }, websiteUri: "https://meiwa.example.jp/", formattedAddress: "日本、〒515-0332 三重県多気郡明和町馬之上945", primaryType: "city_hall" },
          { displayName: { text: "株式会社みえ工務店" }, websiteUri: "https://mie-koumuten.example.jp/", formattedAddress: "日本、〒515-0300 三重県多気郡明和町1", types: ["general_contractor"] },
          { displayName: { text: "相馬郵便局" }, websiteUri: "https://map.japanpost.example/", formattedAddress: "日本、〒370-3100 群馬県高崎市箕郷町", primaryType: "post_office" },
          { displayName: { text: "セブン-イレブン 高崎八島町店" }, websiteUri: "https://www.sej.example.jp/", formattedAddress: "日本、〒370-0849 群馬県高崎市八島町", types: ["convenience_store", "store"] },
          { displayName: { text: "有限会社住所なし製作所" }, websiteUri: "https://nojusho.example.jp/", types: ["point_of_interest"] },
        ],
      }),
    };
  };
  try {
    const results = await searchPlacesAPI("群馬県高崎市", "建設", 20, "建設・不動産", [], "群馬県");
    assert.equal(sent.body.languageCode, "ja");
    assert.equal(sent.body.regionCode, "JP");
    assert.equal(sent.headers["X-Goog-FieldMask"], PLACES_FIELD_MASK);
    for (const f of ["places.displayName", "places.websiteUri", "places.formattedAddress", "places.types", "places.primaryType"]) {
      assert.ok(PLACES_FIELD_MASK.split(",").includes(f), f);
    }
    assert.deepEqual(results.map((r) => r.name), ["株式会社群馬建設", "有限会社住所なし製作所"]);
    assert.equal(results.debug.outside_prefecture_count, 2, "三重県の役場と工務店");
    assert.equal(results.debug.place_type_excluded_count, 2, "郵便局とコンビニ");
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = savedKey;
  }
});
