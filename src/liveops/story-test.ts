import type { Env } from '../env';
import { GameError } from '../game/validation';

// A developer command entered through Coupons, never a replayable reward grant.
export function storyTestEnabledFor(env: Env, playerId: string): boolean {
  return env.STORY_TEST_ENABLED === 'true' &&
    (env.STORY_TEST_PLAYERS ?? '').split(',').map(x => x.trim()).filter(Boolean).includes(playerId);
}

export function checkStoryTestCode(env: Env, playerId: string, supplied: unknown) {
  const configured = (env.STORY_TEST_COUPON ?? '').trim().toUpperCase();
  if (!configured || typeof supplied !== 'string' || supplied.trim().toUpperCase() !== configured) return null;
  if (!storyTestEnabledFor(env, playerId)) throw new GameError('coupon_unavailable', 404);
  return { eligible: true, claimed: false, diagnostic: 'full-story', playerId };
}

export function startStoryTest(env: Env, playerId: string, supplied: unknown) {
  if (!checkStoryTestCode(env, playerId, supplied)) throw new GameError('coupon_unavailable', 404);
  return { diagnostic: 'full-story', playerId, runId: crypto.randomUUID(), speed: 20 };
}

export async function storeStoryTestReport(env: Env, playerId: string, supplied: unknown) {
  if (!storyTestEnabledFor(env, playerId)) throw new GameError('coupon_unavailable', 404);
  const body = supplied as { runId?: unknown; report?: unknown } | null;
  if (!body || typeof body.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.runId) ||
      !body.report || typeof body.report !== 'object' || Array.isArray(body.report))
    throw new GameError('invalid_story_report', 400);
  const json = JSON.stringify({ ...body.report, playerId, runId: body.runId });
  if (new TextEncoder().encode(json).length > 256 * 1024) throw new GameError('request_too_large', 413);
  await env.AUDIT_BLOBS.put(`story-tests/${playerId}/${body.runId}/result.json`, json, {
    httpMetadata: { contentType: 'application/json' },
  });
  return { saved: true, runId: body.runId };
}
