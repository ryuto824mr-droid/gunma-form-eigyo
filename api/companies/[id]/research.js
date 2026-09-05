const { sql } = require("../../../lib/db");
const { analyzeForm } = require("../../../lib/form-analyzer");
const { classifyAppealPoints } = require("../../../lib/appeal-point-classifier");

// vercel.jsonでこの関数のmaxDurationは60秒に設定されている。Puppeteerでの解析が
// 遅いサイト(反応の遅いサーバー、多段階のページ遷移等)でこれを超えると、Vercelに
// 強制終了(504)され、companies.statusが"pending"のまま更新されずに残ってしまい、
// エラーメッセージも一切記録されないため「なぜか終わらない企業」に見えてしまっていた。
// maxDurationの90%が経過した時点で自ら諦めて中間状態(エラー)を保存することで、
// 強制終了される前に必ず何らかの結果を記録できるようにする
const RESEARCH_TIMEOUT_MS = 54000;
const RESEARCH_TIMEOUT_SENTINEL = "__RESEARCH_TIMEOUT__";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const id = parseInt(req.query.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "有効なidが必要です" });
  }

  const [company] = await sql`SELECT * FROM companies WHERE id = ${id}`;
  if (!company) {
    return res.status(404).json({ error: "企業が見つかりません" });
  }

  let result;
  let status;
  let timedOut = false;

  try {
    result = await Promise.race([
      analyzeForm(company.url),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(RESEARCH_TIMEOUT_SENTINEL)), RESEARCH_TIMEOUT_MS);
      }),
    ]);
    if (result.accessBlocked) {
      // NinjaFirewall等のセキュリティプラグインに自動アクセスそのものを拒否されている場合。
      // コード側の再試行では解決できないため、要手動対応として扱う
      status = "access_blocked";
    } else if (result.rejection_detected) {
      status = "rejected";
    } else if (result.captchaDetected) {
      status = "captcha_blocked";
    } else if (!result.formFound && result.iframeFormDetected) {
      // iframe内にフォームらしきものが見つかったが、クロスオリジン制約等で
      // 中身までは解析できなかったケース。自動送信はできないため要手動確認とする
      status = "iframe_form_detected";
    } else if (!result.formFound) {
      status = "no_form";
    } else {
      status = "researched";
    }
  } catch (err) {
    if (err.message === RESEARCH_TIMEOUT_SENTINEL) {
      timedOut = true;
      result = { error: "リサーチがタイムアウトしました。再度お試しください" };
    } else {
      result = { error: err.message };
    }
    status = "error";
  }

  // メールアドレスは自動取得できて、かつ未設定の場合のみ更新する
  const shouldUpdateEmail = !!(result.extractedEmail && !company.email);
  const emailToSet = shouldUpdateEmail ? result.extractedEmail : company.email;

  // 会社概要情報が今回取得できた場合のみ更新し、取得できなかった場合は既存の値を維持する
  const companyInfoToSet = result.companyInfo
    ? JSON.stringify(result.companyInfo)
    : (company.company_info ? JSON.stringify(company.company_info) : null);

  const [updated] = await sql`
    UPDATE companies
    SET
      contact_form_url = ${result.formPageUrl ?? null},
      research_result  = ${JSON.stringify(result)},
      status           = ${status},
      email             = ${emailToSet},
      company_info      = ${companyInfoToSet},
      updated_at       = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  // 訴求ポイントの自動推定（ANTHROPIC_API_KEY未設定時は何もしない。タイムアウト時は
  // 残り時間がほぼ無いため、これ以上時間のかかる処理は行わずすぐ応答を返す）
  if (!timedOut && process.env.ANTHROPIC_API_KEY) {
    try {
      const appealPoints = await classifyAppealPoints(updated);
      if (appealPoints.length > 0) {
        const existingTags = Array.isArray(updated.company_tags) ? updated.company_tags : [];
        const mergedTags = Array.from(new Set([...existingTags, ...appealPoints.map(p => `訴求:${p}`)]));
        if (mergedTags.length !== existingTags.length) {
          const [withTags] = await sql`
            UPDATE companies SET company_tags = ${JSON.stringify(mergedTags)} WHERE id = ${id} RETURNING *
          `;
          return res.status(200).json(withTags);
        }
      }
    } catch {
      // 訴求ポイント判定の失敗はリサーチ結果本体には影響させない
    }
  }

  return res.status(200).json(updated);
};
