// lib/research-retry.js
//
// リサーチ(api/companies/[id]/research.js)が、ブラウザ側の一時的な失敗で終わったときに1回だけやり直すかの判定。
//
// 2026-10-05の一括リサーチでは、169社のerrorのうち約140社がサイト側ではなくブラウザ側の失敗だった
// (net::ERR_INSUFFICIENT_RESOURCES = ブラウザの資源不足、detached Frame 等 = 遷移中のクラッシュ)。
// 同じサイトを開き直すと3分の2はフォームが見つかったため、こうした失敗に限ってやり直す。
// サイト側の問題(ドメインが無い・接続拒否・証明書エラー・タイムアウト)はやり直しても変わらないため対象外。

// ブラウザ側の一時的な失敗(やり直す価値があるもの)
const RETRYABLE_ERROR_RE = /ERR_INSUFFICIENT_RESOURCES|detached Frame|Navigating frame was detached|Target closed|Session closed|Protocol error|Execution context was destroyed/i;

// やり直しに必要な残り時間(1回のリサーチはおおむね10〜25秒)。足りなければやり直さない
const RETRY_MIN_REMAINING_MS = 30000;

function shouldRetryResearch(error, remainingMs) {
  const message = (error && error.message) || "";
  if (!RETRYABLE_ERROR_RE.test(message)) return false;
  return remainingMs >= RETRY_MIN_REMAINING_MS;
}

module.exports = { RETRYABLE_ERROR_RE, RETRY_MIN_REMAINING_MS, shouldRetryResearch };
