import { getDb, getUser, COLLECTIONS, json } from "./_db.mjs";
import { ObjectId } from "mongodb";

export default async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const parts = new URL(req.url).pathname.split("/");
  const orderId = parts[parts.length - 1];
  const db = await getDb();
  const col = db.collection(COLLECTIONS.ORDERS);
  let filter;
  try { filter = { _id: new ObjectId(orderId) }; }
  catch { filter = { order_id: orderId }; }

  if (req.method === "GET") {
    const order = await col.findOne(filter);
    if (!order) return json({ error: "Order not found" }, 404);
    return json(order);
  }

  if (req.method === "PUT") {
    const body = await req.json();
    const result = await col.findOneAndUpdate(
      filter,
      { $set: { ...body, updated_at: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return json({ error: "Order not found" }, 404);
    return json(result);
  }

  if (req.method === "DELETE") {
    await col.updateOne(filter, { $set: { board: "TRASH", updated_at: new Date() } });
    return json({ success: true, message: "Order moved to trash" });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/orders/:id" };
