import { MongoClient } from "mongodb";

let cachedClient = null;

export async function getDb() {
  if (cachedClient) return cachedClient.db();
  const client = new MongoClient(Netlify.env.get("MONGODB_URI"));
  await client.connect();
  cachedClient = client;
  return client.db();
}

export const COLLECTIONS = {
  ORDERS: "orders",
  COMMENTS: "comments",
  AUTOMATIONS: "automations",
  SESSIONS: "sessions",
};

export const BOARDS = ["MASTER", "SCHEDULING", "BLANKS", "SCREENS", "MAQUINA1", "TRASH"];

export const CONFIG_OPTIONS = {
  priorities: ["RUSH", "PRIORITY 1", "PRIORITY 2", "STANDARD"],
  clients: ["LOVE IN FAITH", "TARGET", "WALMART", "AMAZON"],
  brandings: ["LIF Regular", "Target", "Generic"],
  boards: ["MASTER", "SCHEDULING", "BLANKS", "SCREENS", "MAQUINA1"],
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function getToken(req) {
  return (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
}

export async function getUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const db = await getDb();
  return db.collection(COLLECTIONS.SESSIONS).findOne({ token });
}
