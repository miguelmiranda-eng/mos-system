import { CONFIG_OPTIONS, BOARDS, json } from "./_db.mjs";

export default async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/boards")) {
    return json({ boards: BOARDS });
  }
  return json(CONFIG_OPTIONS);
};

export const config = { path: ["/api/config/options", "/api/config/boards"] };
