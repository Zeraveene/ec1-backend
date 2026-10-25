import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['src/auth/browser-completion.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { browserCompletionResponse } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
test('desktop completion does not attempt mobile handoff or expose broker proof', async () => {
  const target = 'gacogames-ec1-bridge://oauth/google?state=private-state&ticket=private-ticket';
  for (const ua of [undefined, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18.0 Safari/605.1.15', 'Mozilla/5.0 (Windows NT 10.0)']) {
    const response = browserCompletionResponse(target, ua);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Location'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    const html = await response.text();
    assert.match(html, /Return to Epic Conquest/);
    assert.doesNotMatch(html, /private-state|private-ticket|<script|gacogames-ec1-bridge/);
  }
});
test('mobile browser keeps existing app handoff', () => {
  const target = 'gacogames-ec1-bridge://oauth/google?state=synthetic&ticket=synthetic';
  for (const ua of ['Mozilla/5.0 (Linux; Android 15)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)']) {
    const response = browserCompletionResponse(target, ua);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), target);
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  }
});
