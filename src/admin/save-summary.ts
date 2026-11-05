import { inspectLegacySave } from './legacy-save';

export function saveSummary(payload: unknown, playtime: number) {
  const view = inspectLegacySave(payload, playtime);
  return {
    state: view.state === 'available' ? 'available' : 'unavailable',
    ruby: view.account.ruby,
    gold: view.account.gold,
    heroLevels: Object.fromEntries(['alaster', 'edna', 'louisa', 'soul'].map(key =>
      [key, view.heroes.find(hero => hero.key === key)?.level ?? null])),
  };
}

/** Bound concurrent R2 reads; a damaged revision must not hide the remaining history. */
export async function summarizeRevisions<T>(rows: T[], read: (row: T) => Promise<{ payload: unknown; playtime: number }>) {
  const results = new Array<ReturnType<typeof saveSummary>>(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      try {
        const { payload, playtime } = await read(rows[index]);
        results[index] = saveSummary(payload, playtime);
      } catch {
        results[index] = saveSummary(undefined, 0);
      }
    }
  }));
  return results;
}
