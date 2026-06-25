// Concurrency-limited parallel map that preserves input order.
// Used to upload photos/files in parallel (a few at a time) instead of
// one-by-one — sequential uploads were the cause of the slowness when
// attaching 5+ photos to a comment or QC record.
export async function mapPool(items, fn, concurrency = 4) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
