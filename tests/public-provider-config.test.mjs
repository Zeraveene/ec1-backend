import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Public source configuration only. Never reads .dev.vars, credentials or remote services.
const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const productionSection = wrangler.split('[vars]')[1].split(/\n\[/)[0];
const productionValue = name => productionSection.match(new RegExp(`^${name} = "([^"]*)"$`, 'm'))?.[1];
const exampleValue = name => example.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];

test('native Apple audience matches the EC1 bundle and public local example', () => {
  assert.equal(productionValue('APPLE_CLIENT_IDS'), 'com.gacogames.epiccon');
  assert.equal(productionValue('APPLE_CLIENT_IDS'), productionValue('IAP_APPLE_BUNDLE_ID'));
  assert.equal(exampleValue('APPLE_CLIENT_IDS'), productionValue('APPLE_CLIENT_IDS'));
});

test('existing Google audience matches the public local example', () => {
  assert.equal(productionValue('GOOGLE_CLIENT_IDS'), '1078144059071-56j0to4phj699691rg0j87iuupd75e1k.apps.googleusercontent.com');
  assert.equal(exampleValue('GOOGLE_CLIENT_IDS'), productionValue('GOOGLE_CLIENT_IDS'));
});

test('legacy cutover enables only migration and manual backups in production', () => {
  for (const name of ['LEGACY_MIGRATION_ENABLED', 'EC1_MANUAL_BACKUPS_ENABLED'])
    assert.equal(productionValue(name), 'true', name);
  for (const name of ['ALLOW_NEW_ACCOUNTS', 'RECOVERY_ENABLED', 'IAP_PURCHASES_ENABLED', 'IAP_ALLOW_TEST_PURCHASES'])
    assert.equal(productionValue(name), 'false', name);
  assert.doesNotMatch(productionSection, /^APPLE_(?:PRIVATE_KEY|CLIENT_SECRET|KEY_ID)\s*=/m);
});

test('dedicated production browser registrations use public identifiers and fixed callbacks only', () => {
  const expected = {
    GOOGLE_BROWSER_CLIENT_ID: '1078144059071-3blfmsc8s3m7vh2g251hjfftkm6hdc9t.apps.googleusercontent.com',
    GOOGLE_BROWSER_REDIRECT_URI: 'https://ec1mod.codezrv.com/api/auth/browser/google/callback',
    APPLE_BROWSER_CLIENT_ID: 'com.gacogames.epiccon.auth',
    APPLE_BROWSER_TEAM_ID: '32ST5862ML',
    APPLE_BROWSER_KEY_ID: '6GN787AK68',
    APPLE_BROWSER_REDIRECT_URI: 'https://ec1mod.codezrv.com/api/auth/browser/apple/callback',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(productionValue(name), value, name);
  assert.doesNotMatch(productionSection, /^(?:GOOGLE_BROWSER_CLIENT_SECRET|APPLE_BROWSER_PRIVATE_KEY)\s*=/m);
  assert.notEqual(productionValue('GOOGLE_CLIENT_IDS'), productionValue('GOOGLE_BROWSER_CLIENT_ID'));
  assert.notEqual(productionValue('APPLE_CLIENT_IDS'), productionValue('APPLE_BROWSER_CLIENT_ID'));
});
