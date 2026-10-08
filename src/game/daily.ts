import type { Env } from "../env";
import { objectJson, sha256 } from "./validation";
import { loadSnapshot } from "./storage";

const dayMs = 86_400_000;
export const dailyResetPeriod = (time: number) => Math.floor(time / dayMs);
export async function dailyResetState(
  env: Env,
  playerId: string,
  time = Date.now(),
) {
  const period = dailyResetPeriod(time);
  const receipt = await env.DB.prepare(
    "SELECT 1 FROM grant_receipt WHERE player_id=? AND source_id=?",
  )
    .bind(playerId, `daily-reset:${period}`)
    .first();
  // A migrated legacy reset completed today must not refresh its already used allowances again.
  // Later native periods are determined solely by durable receipts and the UTC server clock.
  const latest = await env.DB.prepare(
    "SELECT MAX(CAST(SUBSTR(source_id,13) AS INTEGER)) AS period FROM grant_receipt WHERE player_id=? AND source_id LIKE 'daily-reset:%'",
  )
    .bind(playerId)
    .first<{ period: number | null }>();
  let legacyAlreadyReset = false;
  if (latest?.period == null && !receipt) {
    const saved = await loadSnapshot(env, playerId),
      prefs = objectJson(saved.data.CLOUD_ALL_DATA, "CLOUD_ALL_DATA");
    const lastRewardTime = Date.parse(String(prefs.LastRewardTime || ""));
    legacyAlreadyReset =
      prefs.dailyReset === "1" &&
      Number.isFinite(lastRewardTime) &&
      dailyResetPeriod(lastRewardTime) === period;
  }
  const advanced = latest?.period == null || period > latest.period;
  return {
    period,
    eligible: advanced && !receipt && !legacyAlreadyReset,
    nextEligibleAt:
      Math.max(period + 1, (latest?.period ?? period) + 1) * dayMs,
    timezone: "UTC",
    serverTime: time,
  };
}
export async function resetDailyPreferences(
  prefs: Record<string, string>,
  playerId: string,
  period: number,
) {
  // EC1 DailyQuest.RefreshQuest chooses three distinct QuestType values with Random.Range(0,12).
  // Account/period hashing gives stable server choices across concurrent operations and response loss.
  const digest = await sha256(`${playerId}:daily-reset:${period}`),
    choices = Array.from({ length: 12 }, (_, i) => i);
  for (let i = 0; i < 3; i++) {
    const index = parseInt(digest.slice(i * 8, i * 8 + 8), 16) % choices.length;
    prefs[`task${i}`] = String(choices.splice(index, 1)[0]);
    prefs[`task${i}_progress`] = "0";
    prefs[`task${i}_claimed`] = "0";
  }
  prefs.task_all_claimed = "0";
  // -1 is the full-snapshot representation of the historical absent/unactivated quota preference.
  prefs.dailyBoosterQuota = "-1";
  prefs.dailyReset = "1";
  for (const key of ["entry_treasure", "entry_march", "entry_chaos"])
    prefs[key] = prefs.premium === "1" ? "3" : "2";
  const game = objectJson(prefs.gamedata, "gamedata");
  for (const key of ["fox_hunger", "golem_hunger", "fairy_hunger"])
    game[key] = 0;
  prefs.gamedata = JSON.stringify(game);
}
