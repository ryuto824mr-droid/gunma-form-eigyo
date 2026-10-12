// lib/ai-error.js
//
// リサーチで使うAI(欄の判定・訴求タグの推定)の失敗を種類に分け、目立つ警告にするための判定。
//
// 2026-09-08〜10-12、Anthropicのクレジット不足で欄の判定が黙って簡易判定に切り替わり続けた
// (エラーは企業の詳細画面の奥に小さく出るだけで、約1か月気づけなかった)。
// また、欄が非常に多い・欄名が長いフォームでは、AIの出力が途中で切れて判定に失敗していた。

const KINDS = [
  { kind: "credit", label: "クレジット不足", re: /credit balance/i },
  { kind: "auth", label: "APIキーの問題", re: /status 401|status 403|authentication_error|permission_error|invalid x-api-key|ANTHROPIC_API_KEY が/i },
  { kind: "rate", label: "回数制限・混雑", re: /status 429|status 529|rate_limit|overloaded/i },
  { kind: "truncated", label: "出力が上限で切れた", re: /上限.*切れ/ },
  { kind: "parse", label: "出力の形式が不正", re: /JSONとして解析|テキストが含まれていません/ },
  { kind: "network", label: "通信エラー", re: /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket|network|aborted|通信エラー/i },
];

// AIのエラーメッセージ → { kind, label }。空なら null
function classifyAIError(message) {
  if (!message) return null;
  const text = String(message);
  const hit = KINDS.find((k) => k.re.test(text));
  return hit ? { kind: hit.kind, label: hit.label } : { kind: "other", label: "その他のエラー" };
}

// 設定・残高の問題で、直すまで全社のAI判定が止まる種類
const BLOCKING_KINDS = new Set(["credit", "auth"]);

const DAY_MS = 24 * 60 * 60 * 1000;

// 「あとで送る」の上部に出す、直近のAI判定の状況。
//   companies: [{ archived, updated_at, ai_error, appeal_error, mapping_source }](リサーチの記録から取り出したもの)
// 戻り値: { failed_7d, by_kind: { credit: n, ... }, last_failure_at, last_failure_kind, last_failure_label,
//           last_success_at, failing, blocking }
//   failing: 最後のAI判定の失敗が、最後の成功より新しい(今も失敗している可能性が高い)
//   blocking: failing で、しかも最後の失敗がクレジット不足・APIキーの問題
function summarizeAIStatus(companies, now = Date.now(), days = 7) {
  const since = now - days * DAY_MS;
  const byKind = {};
  let failed = 0;
  let lastFailure = null;
  let lastSuccessAt = null;
  for (const c of companies || []) {
    if (c.archived === true) continue;
    const at = c.updated_at ? new Date(c.updated_at).getTime() : NaN;
    if (!Number.isFinite(at)) continue;
    if (c.mapping_source === "ai" && !c.ai_error && (!lastSuccessAt || at > lastSuccessAt)) lastSuccessAt = at;
    const info = classifyAIError(c.ai_error) || classifyAIError(c.appeal_error);
    if (!info) continue;
    if (!lastFailure || at > lastFailure.at) lastFailure = { at, ...info };
    if (at >= since) {
      failed++;
      byKind[info.kind] = (byKind[info.kind] || 0) + 1;
    }
  }
  const failing = !!lastFailure && lastFailure.at >= since && (!lastSuccessAt || lastFailure.at > lastSuccessAt);
  return {
    failed_7d: failed,
    by_kind: byKind,
    last_failure_at: lastFailure ? new Date(lastFailure.at).toISOString() : null,
    last_failure_kind: lastFailure ? lastFailure.kind : null,
    last_failure_label: lastFailure ? lastFailure.label : null,
    last_success_at: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
    failing,
    blocking: failing && BLOCKING_KINDS.has(lastFailure.kind),
  };
}

module.exports = { classifyAIError, summarizeAIStatus, BLOCKING_KINDS };
