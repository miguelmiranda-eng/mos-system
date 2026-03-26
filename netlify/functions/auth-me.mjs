import { getUser, json } from "./_db.mjs";

export default async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  return json({ user });
};

export const config = { path: "/api/auth/me" };
