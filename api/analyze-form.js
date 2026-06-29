// api/analyze-form.js — lib/form-analyzer.js の薄いラッパー
const { analyzeForm } = require("../lib/form-analyzer");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POSTメソッドのみ対応しています" });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url（文字列）が必要です" });
  }

  try {
    const result = await analyzeForm(url);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: `解析中にエラーが発生しました: ${err.message}` });
  }
};
