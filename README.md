# ぐんまフォーム営業ツール (Phase 1: フォーム発見・解析)

企業サイトの「お問い合わせフォーム」を自動で発見し、フィールド構成を解析、
AI（Claude API）でフィールドの役割を推定し、自動送信が可能かどうかを判定するツールです。
LOCLEの既存「gunma-SaaS」とは別プロジェクトです。

## できること（Phase 1の範囲）

- 指定したURLにアクセスし、「お問い合わせ」系のリンクを自動発見
- フォーム内の入力フィールド（name, id, label, placeholder, 必須/任意など）を抽出
- reCAPTCHA / hCaptcha / Cloudflare Turnstile の有無を検出
- Claude APIでフィールドを役割（会社名・メール・本文 など）に分類
- 上記をもとに `automatable`（自動送信して良さそうか）を判定

**まだ実装していないもの（Phase 2以降）**：実際のフォーム入力・送信、バッチ処理、
反応トラッキング、分析ダッシュボード。

## セットアップ

```bash
npm install
```

ローカル開発には Vercel CLI が必要です。

```bash
npm install -g vercel
vercel dev
```

`.env.example` を参考に `.env` を作成し、Claude APIキーを設定してください。

```
ANTHROPIC_API_KEY=sk-ant-...
```

Vercelにデプロイする場合は、Project Settings > Environment Variables に
同じ変数を登録してください（前回のgunma-SaaSで起きた「認証ヘッダー漏れで
AI機能が無言で空になる」問題を踏まえて、このコードではAPIエラー時に
必ずエラーメッセージを返すようにしています。`aiError` フィールドを確認してください）。

## データベースのセットアップ・マイグレーション

テーブル作成やカラム追加などのスキーマ変更は `POST /api/crm?action=db-setup` を叩くことで適用されます
（`db/schema.sql` の `CREATE TABLE IF NOT EXISTS` と、`api/crm.js` の `handleDbSetup` 内の
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 文が実行されます。すべて `IF NOT EXISTS` 付きのため、
複数回実行しても安全です）。

初回セットアップ時、および companies テーブルへのカラム追加などスキーマ変更を含むデプロイの後は、
デプロイ完了後に一度だけ以下を実行してください（`SETUP_SECRET` 環境変数の値を指定します）。

```bash
curl -X POST https://<your-deployment-url>/api/crm?action=db-setup \
  -H "Content-Type: application/json" \
  -d '{"secret": "<SETUP_SECRET>"}'
```

- `SETUP_SECRET` はVercelの Project Settings > Environment Variables に事前に登録しておく必要があります。
- 企業メモ機能（`companies.memo` カラム）の追加など、既存本番DBに対する追加カラムのマイグレーションも
  このエンドポイントの再実行で反映されます。デプロイ後に実行し忘れると、該当機能がDBエラーで
  動作しませんのでご注意ください。

## 使い方

`vercel dev` 後、ブラウザで `http://localhost:3000` を開き、企業URLを入力して
「解析する」を押すとAPIが実行されます。

直接APIを呼ぶ場合：

```bash
curl -X POST http://localhost:3000/api/analyze-form \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.co.jp"}'
```

## 重要な制約・注意点

- **このチャット環境からは実在の企業サイトに対するテストができていません。**
  この環境のネットワークはGitHub/npm関連ドメインのみ許可されており、任意の外部サイトへ
  アクセスできないためです。実際に動かす前に、ご自身の環境（`vercel dev` やデプロイ後）で
  何社か実URLを使って必ず動作確認をしてください。フォーム構造は企業ごとに千差万別なので、
  最初の数十社は精度を見ながら調整が必要になる前提でいてください。
- **CAPTCHAが検出された場合は自動化対象外とし、回避策の実装は行いません。**
  `captchaDetected: true` の企業は `automatable: false` になります。
- **Vercelの実行時間制限**：Hobbyプランは標準10秒（設定で最大60秒まで延長可能な場合あり）、
  Proプランは最大300秒まで延長可能です。`vercel.json` で `maxDuration: 30` を設定していますが、
  プランによって上限が異なるため、本番運用前にVercelのダッシュボードで確認してください。
  サイトの応答が遅い場合はタイムアウトする可能性があります。
- **JS必須のSPA的なフォーム**（独自のフォームライブラリ等）は `networkidle2` まで待ってから
  解析していますが、ラベルの紐付けや動的生成フィールドの取得に失敗するケースがあります。

## 今後のフェーズ（提案）

- Phase 2: 解析結果を使って実際に1社へテスト送信（フィールドへの自動入力・送信ボタン押下）
- Phase 3: バッチ処理（Vercel Cron）・送信トリガー設定UI（即時送信/承認制/スケジュール）・
  返信メールとの紐付けによる反応トラッキング・variant_idごとの集計ダッシュボード
