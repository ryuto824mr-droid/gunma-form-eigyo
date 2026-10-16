# ぐんまフォーム営業ツール

企業探し → リサーチ(問い合わせフォーム・メールの発見と解析) → 送信 → 返信の確認までを行う営業ツールです。
LOCLE と 群馬お仕事図鑑 の2つのプロジェクトで使います(データはプロジェクトごとに分かれています)。
LOCLEの既存「gunma-SaaS」とは別プロジェクトです。

- 本番: Vercel(Hobby プラン)
- DB: Neon Postgres
- 画面: `public/*.html`(ビルドなしの静的ページ)
- API: `api/*.js`(Vercel Functions)

画面ごとの使い方は `public/help.html`(画面の「使い方」)にあります。

## できること

| 手順 | 自動 / 手動 | 画面 |
|---|---|---|
| 企業探し(業種×市町村を日ごとに順番に検索) | 自動(毎日1回) / 手動 | 送信管理・企業リスト |
| 登録 | 自動(新しい企業は「保留」に入る) / 手動 | 企業リスト |
| リサーチ(フォーム・メール・会社情報・営業お断り・CAPTCHA の検出) | 自動(新規のみ) / 手動 | 企業リスト |
| 送るかどうかの確認・送信待ちに入れる | 手動 | あとで送る |
| 送信(送信待ちの行) | 自動(平日 18:00) | - |
| 送れたかの確認(不明・失敗) | 手動 | 送信管理 |
| 返信の確認 | 自動(毎日1回) / 手動 | 分析 |

AI(Claude API)は、フォームの欄の判定・企業探しの絞り込み・訴求タグの推定などに使います。
AI が失敗したときは画面上部に警告を出し、推測のまま送らないようにしています。

## 毎日の自動処理(Vercel の cron)

`vercel.json` の `crons` に2つあります。どちらも毎日 09:00 UTC(日本時間 18:00)です。

1. `/api/crm?action=run-scheduled-sends`
   - 1回の持ち時間は約290秒です。
   - 内訳: 予約送信 → 自動パイプライン(最大48秒) → 送信待ち(最大20件)
   - 土日祝はスキップします(設定で変更可)。
   - 1社あたり10〜25秒かかるため、1日の送信は10〜15件ほどです。
   - **Vercel の cron 以外からは実行できません。** 環境変数 `CRON_SECRET` の値と、
     Vercel の cron が付ける `Authorization: Bearer <CRON_SECRET>` が一致したときだけ動きます。
     `CRON_SECRET` が未登録のときも実行しません(URL を開いただけで送信が始まらないようにするため)。
2. `/api/analytics?action=check-replies`
   - Gmail の返信を確認します(送信はしません)。

## 環境変数(Vercel の Project Settings > Environment Variables)

値はここには書きません。名前と用途だけです。

| 名前 | 用途 |
|---|---|
| `DATABASE_URL` | Neon Postgres の接続先 |
| `ANTHROPIC_API_KEY` | Claude API |
| `SETUP_SECRET` | DB の初期設定(`db-setup`)と診断表示の鍵 |
| `CRON_SECRET` | 毎日の送信(`run-scheduled-sends`)の鍵。Vercel の cron が自動で付ける |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | Gmail での送信・返信の確認 |
| `SENDER_EMAIL` | 送信元のメールアドレス(未登録なら Gmail の認証したアカウント) |
| `GOOGLE_PLACES_API_KEY` | 企業探し(Google Places) |
| `BRAVE_SEARCH_API_KEY` | 企業探し(Web 検索) |
| `APP_BASE_URL` | メール内のクリック計測リンクに使う本番の URL(未登録なら本番の URL) |

環境変数を変えたら、次のデプロイから反映されます。

## ログイン・権限

- **ログインはありません。** URL を知っていれば誰でも画面と API を使えます。URL を外部の人に渡さないでください。
- 権限の区別もありません(全員が同じ操作をできます)。
- 鍵で守っているのは、毎日の送信(`CRON_SECRET`)と DB の初期設定・診断表示(`SETUP_SECRET`)だけです。

## 開発

```bash
npm install
npm test           # 単体テスト(DB・ブラウザ・外部APIは使わない)
npm run test:e2e   # 手元のブラウザを使う通しテスト(127.0.0.1 だけにつなぐ)
```

ローカルで動かすには Vercel CLI を使います(`npm install -g vercel` → `vercel dev`)。

### DB のセットアップ・マイグレーション

テーブル作成やカラム追加は `POST /api/crm?action=db-setup` で適用されます
(`db/schema.sql` と、`api/crm.js` の `handleDbSetup` 内の `IF NOT EXISTS` 付きの文。何度実行しても安全です)。
スキーマ変更を含むデプロイの後は、**デプロイが終わってから** 一度だけ実行してください。

```bash
curl -X POST https://<your-deployment-url>/api/crm?action=db-setup \
  -H "Content-Type: application/json" \
  -d '{"secret": "<SETUP_SECRET>"}'
```

## 制約・注意点

- **Vercel Hobby の関数は12個まで。** `api/` のファイルは12個のままにし、新しい処理は
  `api/crm.js` の `?action=` に足します。
- 関数の最大実行時間: `api/crm.js` は300秒、リサーチと送信は60秒(`vercel.json`)。
- Hobby の cron は1日1回で、実行時刻は多少ずれます。
- **CAPTCHA・画像認証・営業お断りが見つかった企業は自動送信しません。** 回避策は実装しません。
- 宛名(企業名)が不確かなときは、名前を入れず「ご担当者様」で送ります。
  このような企業は送信待ち・保留に入れられません(企業名を直してから入れます)。
- フォームの作りは企業ごとに違うため、送れたか分からない(uncertain)結果が出ます。
  送信管理の送信履歴で確認してください。
