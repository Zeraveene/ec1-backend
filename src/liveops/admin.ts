import type { Env } from '../env';
import { itemCatalog } from '../game/rewards';
import { dispatchCouponAdmin } from './coupons';
import { dispatchMailAdmin } from './mail';
import { dispatchNewsAdmin } from './news';
import { dispatchLeaderboardAdmin } from './leaderboards';
import type { AdminActor } from './grants';
import type { AdminRole } from '../admin/action-types';
const reads: Record<string, string[]> = { coupons: ['list', 'detail'], mail: ['history', 'detail'], news: ['list', 'detail'], leaderboards: ['status', 'history', 'top'] };
const writes: Record<string, string[]> = { coupons: ['create', 'update', 'disable'], mail: ['send', 'disable'], news: ['create', 'update', 'publish', 'archive', 'reorder'], leaderboards: ['pause', 'reset', 'season'] };
/** Explicit feature/action allowlists prevent reads from dispatching a mutation. */
export async function dispatchLiveopsAdmin(env: Env, actor: AdminActor, role: AdminRole, feature: string, action: string, args: Record<string, unknown>, write: boolean): Promise<{
    status: number;
    body: unknown;
}> {
    if (!['internal', 'manager', 'guest'].includes(role))
        return { status: 403, body: { error: 'forbidden' } };
    const allowed = write ? writes : reads;
    if (!Object.hasOwn(allowed, feature) || !allowed[feature].includes(action))
        return { status: 404, body: { error: 'not_found' } };
    if (write && role === 'guest')
        return { status: 403, body: { error: 'forbidden' } };
    const dispatch = { coupons: dispatchCouponAdmin, mail: dispatchMailAdmin, news: dispatchNewsAdmin, leaderboards: dispatchLeaderboardAdmin }[feature as 'coupons' | 'mail' | 'news' | 'leaderboards'];
    return dispatch(env, actor, role, `${feature}.${action}`, args);
}
export function rewardCatalog() {
    return { game: 'ec1', items: [
            { id: 'gold', name: 'Gold', maxAmount: 2147483647 }, { id: 'ruby', name: 'Ruby', maxAmount: 2147483647 },
            ...Object.entries(itemCatalog).map(([id, entry]) => ({ id, name: entry.item.m_name, itemCategory: entry.category, maxAmount: entry.item.stack })),
            ...['alaster', 'edna', 'louisa', 'soul'].flatMap(hero => Array.from({ length: 8 }, (_, i) => ({ id: `costume_${hero}_${i + 1}`, name: `${hero} costume ${i + 1}`, maxAmount: 1 }))),
        ] };
}
