/**
 * The first `limit` items, in their given order, that pass an async check. The check runs on
 * `batch` items at a time (each costs several queries) and stops once `limit` have passed.
 */
export async function firstEligible<T>(
  items: readonly T[],
  check: (item: T) => Promise<boolean>,
  limit: number,
  batch: number,
): Promise<T[]> {
  const kept: T[] = [];
  for (let i = 0; i < items.length && kept.length < limit; i += batch) {
    const slice = items.slice(i, i + batch);
    const verdicts = await Promise.all(slice.map(check));
    slice.forEach((item, k) => { if (verdicts[k] && kept.length < limit) kept.push(item); });
  }
  return kept;
}
