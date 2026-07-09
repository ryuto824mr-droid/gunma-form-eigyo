const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

async function isExcludedDomain(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  const rows = await sql`SELECT domain FROM excluded_domains`;
  return rows.some(r => r.domain.toLowerCase().replace(/^www\./, "") === hostname);
}

module.exports = { sql, isExcludedDomain };
