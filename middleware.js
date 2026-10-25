// middleware.js
//
// Vercel の Routing Middleware。全ページ・全APIの要求の前に走り、共通パスワードでの守りを掛ける。
// 判定の中身は lib/auth-gate.js(テストできる純粋な関数)。何も返さなければ、要求はそのまま
// ページ・API に進む。api/ の関数の数(Hobby の上限12)には入らない。

import authGate from "./lib/auth-gate.js";

export const config = {
  runtime: "nodejs",
};

export default async function middleware(request) {
  const response = await authGate.gate(request, process.env);
  return response || undefined;
}
