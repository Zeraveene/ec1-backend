import { Hono } from 'hono';
import { createClassicAdminControl } from './control';

// The isolated production module receives the original absolute request path.
// Mount the child routes exactly as the normal Worker entrypoint does.
export default new Hono().route('/api/classic-admin', createClassicAdminControl());
