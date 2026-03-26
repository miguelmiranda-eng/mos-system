import { getDb, getUser, COLLECTIONS, json } from "./_db.mjs";
import { ObjectId } from "mongodb";

export default async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const db = await getDb();
  const col = db.collection(COLLECTIONS.AUTOMATIONS);

  if (req.method === "GET") {
    const automations = await col.find({}).sort({ created_at: -1 }).toArray();
    return json(automations);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const automation = {
      ...body,
      created_at: new Date(),
      created_by: user.user_id || user._id,
      active: true,
    };
    const result = await col.insertOne(automation);
    return json({ automation_id: result.insertedId, ...automation });
  }

  if (req.method === "DELETE") {
    const id = parts[parts.length - 1];
    let filter;
    try { filter = { _id: new ObjectId(id) }; }
    catch { filter = { automation_id: id }; }
    await col.deleteOne(filter);
    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: ["/api/automations", "/api/automations/:id"] };
