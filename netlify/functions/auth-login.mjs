import { getDb, COLLECTIONS, json } from "./_db.mjs";
import crypto from "crypto";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { username, password } = await req.json();
  if (!username || !password) return json({ error: "Usuario y contraseña requeridos" }, 400);

  const db = await getDb();
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  const user = await db.collection(COLLECTIONS.USERS).findOne({ username, password: hash });

  if (!user) return json({ error: "Usuario o contraseña incorrectos" }, 401);

  const token = crypto.randomBytes(32).toString("hex");
  await db.collection(COLLECTIONS.SESSIONS).insertOne({
    token,
    user_id: user._id,
    username: user.username,
    role: user.role || "user",
    created_at: new Date(),
  });

  return json({ token, user: { username: user.username, role: user.role || "user" } });
};

export const config = { path: "/api/auth/login" };
