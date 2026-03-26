import { getDb, getUser, COLLECTIONS, json } from "./_db.mjs";

export default async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const db = await getDb();
  const col = db.collection(COLLECTIONS.ORDERS);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const board = url.searchParams.get("board");
    const filter = board ? { board } : {};
    const orders = await col.find(filter).sort({ created_at: -1 }).toArray();
    return json(orders);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const order = {
      ...body,
      board: "SCHEDULING",
      production_status: "PENDING",
      created_at: new Date(),
      updated_at: new Date(),
      created_by: user.user_id || user._id,
    };
    const result = await col.insertOne(order);
    return json({ order_id: result.insertedId, ...order });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/orders" };
