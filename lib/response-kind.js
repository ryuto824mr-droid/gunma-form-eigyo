// lib/response-kind.js
//
// 反応(responses)の種類の判定。反応は3つの経路で記録される:
//   1. メール本文のリンクがクリックされたときの自動記録(api/crm.js の track-click)
//      → classification='interested'、raw_excerpt=AUTO_CLICK_EXCERPT、message_idは空
//   2. Gmailの返信検出(api/analytics.js の check-replies) → message_idあり
//   3. 送信管理画面からの手動の記録(api/send-logs/[id]/response.js)
// 1は相手のメールサーバーのセキュリティ機能が送信直後にリンクを自動で開いた場合にも記録される
// (2026-09-21の2件は送信から93秒・5秒後だった)ため、人からの反応(2・3)と区別して扱う。

const AUTO_CLICK_EXCERPT = "リンククリックによる自動記録";

function isAutoClickResponse(response) {
  return !!response &&
    response.raw_excerpt === AUTO_CLICK_EXCERPT &&
    !response.message_id;
}

module.exports = { AUTO_CLICK_EXCERPT, isAutoClickResponse };
