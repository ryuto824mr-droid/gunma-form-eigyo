const { sql } = require("../../../lib/db");
const { analyzeForm } = require("../../../lib/form-analyzer");
const { areaOf } = require("../../../lib/area");
const { classifyAppealPointsDetailed } = require("../../../lib/appeal-point-classifier");
const { classifyAIError } = require("../../../lib/ai-error");
const { isPlaceholderEmail } = require("../../../lib/email-placeholder");
const { shouldRetryResearch } = require("../../../lib/research-retry");

// vercel.jsonでこの関数のmaxDurationは60秒に設定されている。Puppeteerでの解析が
// 遅いサイト(反応の遅いサーバー、多段階のページ遷移等)でこれを超えると、Vercelに
// 強制終了(504)され、companies.statusが"pending"のまま更新されずに残ってしまい、
// エラーメッセージも一切記録されないため「なぜか終わらない企業」に見えてしまっていた。
// maxDurationの90%が経過した時点で自ら諦めて中間状態(エラー)を保存することで、
// 強制終了される前に必ず何らかの結果を記録できるようにする
const RESEARCH_TIMEOUT_MS = 54000;
const RESEARCH_TIMEOUT_SENTINEL = "__RESEARCH_TIMEOUT__";

// エラーメッセージから大まかな原因を分類する。原因によって「サイト側が
// そもそも繋がらない(connection_error)」のか「繋がるが遅すぎる(slow_response)」
// のかが変わり、対応方針(再試行が有効かどうか等)も異なるため区別して記録する
const CONNECTION_ERROR_RE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_SSL_PROTOCOL_ERROR|ERR_CERT_|ERR_EMPTY_RESPONSE|ERR_FAILED/i;
const SLOW_RESPONSE_RE = /navigation timeout|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|timeout of \d+ ?ms exceeded/i;

// ブラウザ側の一時的な失敗(資源不足・遷移中のクラッシュ)で終わった場合、残り時間が十分あれば
// 1回だけやり直す(判定は lib/research-retry.js)。やり直した場合は結果の警告にその旨を残す
async function analyzeFormWithRetry(url, deadline, options = {}) {
  try {
    return await analyzeForm(url, options);
  } catch (err) {
    if (!shouldRetryResearch(err, deadline - Date.now())) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    const result = await analyzeForm(url, options);
    result.analysisWarnings = [
      ...(result.analysisWarnings || []),
      `1回目がブラウザ側の失敗で終わったため再試行しました: ${String(err.message).slice(0, 200)}`,
      ...(err.diagnostics || []).map((line) => `1回目の${line}`),
    ];
    return result;
  }
}

// 会社のプロジェクトの営業の対象の地域(lib/area.js)。設定が無い・読めないときは群馬県だけ(今までどおり)
async function loadArea(project) {
  try {
    const [config] = await sql`SELECT search_params FROM auto_pipeline_config WHERE project = ${project} LIMIT 1`;
    return areaOf(config || null);
  } catch {
    return areaOf(null);
  }
}

function classifyErrorType(message) {
  if (!message) return "error";
  if (CONNECTION_ERROR_RE.test(message)) return "connection_error";
  if (SLOW_RESPONSE_RE.test(message)) return "slow_response";
  return "error";
}

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
    const deadline = Date.now() + RESEARCH_TIMEOUT_MS;
    result = await Promise.race([
      analyzeFormWithRetry(company.url, deadline, { area: await loadArea(company.project), foundPrefecture: company.found_prefecture || null }),
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
      result = { error: "リサーチがタイムアウトしました。再度お試しください", errorType: "slow_response" };
    } else {
      // lib/form-analyzer.js が付けた診断(起動前・終了後の実行環境の状態)も記録に残す
      result = { error: err.message, errorType: classifyErrorType(err.message), analysisWarnings: err.diagnostics || [] };
    }
    status = "error";
  }

  // メールアドレスは自動取得できて、かつ未設定の場合のみ更新する。
  // 登録済みのアドレスが入力例・仮のアドレス(sample@・toiawase@domain.co.jp 等)の場合は未設定と同じに扱い、
  // 本物が見つかれば置き換える(元の値は research_result.previousEmail に残す。削除はしない)。
  // 以前は仮のアドレスが入っていると、本物が見つかっても保存されなかった
  const currentIsPlaceholder = !!company.email && isPlaceholderEmail(company.email).placeholder;
  const shouldUpdateEmail = !!(result.extractedEmail && (!company.email || currentIsPlaceholder));
  if (shouldUpdateEmail && currentIsPlaceholder) result.previousEmail = company.email;
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
      const { points: appealPoints, error: appealError } = await classifyAppealPointsDetailed(updated);
      if (appealError) {
        // 失敗(クレジット不足等)は「該当なし」と区別できるよう、リサーチの記録に目立つ警告として残す
        const info = classifyAIError(appealError);
        const saved = typeof updated.research_result === "string"
          ? JSON.parse(updated.research_result)
          : { ...(updated.research_result || {}) };
        saved.appealError = String(appealError).slice(0, 300);
        saved.appealErrorKind = info.kind;
        saved.analysisWarnings = [...(saved.analysisWarnings || []), `⚠ 訴求タグの推定に失敗(${info.label})`];
        const [withWarning] = await sql`
          UPDATE companies SET research_result = ${JSON.stringify(saved)} WHERE id = ${id} RETURNING *
        `;
        return res.status(200).json(withWarning);
      }
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
