const { sql } = require("../../../lib/db");
const { analyzeForm } = require("../../../lib/form-analyzer");

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

  try {
    result = await analyzeForm(company.url);
    if (result.captchaDetected) {
      status = "captcha_blocked";
    } else if (!result.formFound) {
      status = "no_form";
    } else {
      status = "researched";
    }
  } catch (err) {
    result = { error: err.message };
    status = "error";
  }

  const [updated] = await sql`
    UPDATE companies
    SET
      contact_form_url = ${result.formPageUrl ?? null},
      research_result  = ${JSON.stringify(result)},
      status           = ${status},
      updated_at       = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  return res.status(200).json(updated);
};
