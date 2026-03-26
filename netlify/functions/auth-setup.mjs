// Endpoint ONE-TIME para crear el usuario admin inicial
// Visita /api/auth/setup una vez y luego bórralo
import { getDb, COLLECTIONS, json } from "./_db.mjs";
import crypto from "crypto";

export default async (req) => {
  const db = await getDb();
  const existing = await db.collection(COLLECTIONS.USERS).findOne({ username: "admin" });
  if (existing) return json({ message: "Usuario admin ya existe" });

  const hash = crypto.createHash("sha256").update("admin123").digest("hex");
  await db.collection(COLLECTIONS.USERS).insertOne({
    username: "admin",
    password: hash,
    role: "admin",
    created_at: new Date(),
  });

  return json({ message: "✅ Usuario creado exitosamente", username: "admin", password: "admin123" });
};

export const config = { path: "/api/auth/setup" };
