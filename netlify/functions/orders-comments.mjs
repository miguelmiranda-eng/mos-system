import { getDb, getUser, COLLECTIONS, json } from "./_db.mjs";

export default async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const parts = new URL(req.url).pathname.split("/");
  const orderId = parts[parts.length - 2];
  const db = await getDb();
  const col = db.collection(COLLECTIONS.COMMENTS);

  if (req.method === "GET") {
    const comments = await col.find({ order_id: orderId }).sort({ created_at: 1 }).toArray();
    return json(comments);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const comment = {
      order_id: orderId,
      content: body.content,
      author: user.user_id || user._id,
      created_at: new Date(),
    };
    const result = await col.insertOne(comment);
    return json({ comment_id: result.insertedId, ...comment });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/orders/:id/comments" };
