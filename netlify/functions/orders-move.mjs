import { getDb, getUser, COLLECTIONS, BOARDS, json } from "./_db.mjs";
import { ObjectId } from "mongodb";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const isBulk = url.pathname.endsWith("bulk-move");
  const body = await req.json();
  const { board } = body;
  if (!board || !BOARDS.includes(board))
    return json({ error: `Board inválido. Opciones: ${BOARDS.join(", ")}` }, 400);

  const db = await getDb();
  const col = db.collection(COLLECTIONS.ORDERS);

  if (isBulk) {
    const { order_ids } = body;
    if (!Array.isArray(order_ids) || order_ids.length === 0)
      return json({ error: "order_ids requerido" }, 400);
    const ids = order_ids.map(id => { try { return new ObjectId(id); } catch { return id; } });
    const result = await col.updateMany(
      { _id: { $in: ids } },
      { $set: { board, updated_at: new Date() } }
    );
    return json({ success: true, moved: result.modifiedCount, board });
  }

  const parts = url.pathname.split("/");
  const orderId = parts[parts.length - 2];
  let filter;
  try { filter = { _id: new ObjectId(orderId) }; }
  catch { filter = { order_id: orderId }; }

  const result = await col.findOneAndUpdate(
    filter,
    { $set: { board, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) return json({ error: "Order not found" }, 404);
  return json({ success: true, order: result });
};

export const config = { path: ["/api/orders/bulk-move", "/api/orders/:id/move"] };
