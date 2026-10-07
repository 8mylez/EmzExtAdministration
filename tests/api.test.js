import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminApi } from '../src/Resources/public/js/api.js';

function setup() {
    const values = new Map();
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const api = new AdminApi('/api', 'language', storage);
    api.saveTokens({ access_token: 'old', refresh_token: 'refresh', expires_in: 600 }, 0);
    return api;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Parallele Anfragen erneuern das Token nur einmal', async t => {
    const api = setup();
    api.tokens.expiresAt = 0;
    let refreshes = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url.endsWith('/oauth/token')) {
            refreshes++;
            await new Promise(resolve => setTimeout(resolve, 5));
            return json({ access_token: 'new', refresh_token: 'next', expires_in: 600 });
        }
        assert.equal(options.headers.Authorization, 'Bearer new');
        return json({ data: [] });
    });
    await Promise.all([api.search('product'), api.search('product'), api.search('product')]);
    assert.equal(refreshes, 1);
});

test('Abgelaufenes Refresh-Token beendet die Sitzung', async t => {
    const api = setup();
    api.tokens.expiresAt = 0;
    let expired = 0;
    api.onExpired = () => expired++;
    t.mock.method(globalThis, 'fetch', async () => json({ error_description: 'Expired' }, 400));
    await assert.rejects(api.search('product'));
    assert.equal(api.tokens, null);
    assert.equal(expired, 1);
});

test('403 löst keinen Refresh aus und Rechte stammen aus dem aktuellen Benutzer', async t => {
    const api = setup();
    api.user = { admin: false, aclRoles: [{ privileges: ['product:read'] }] };
    assert.equal(api.can('product:read'), true);
    assert.equal(api.can('product:update'), false);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ errors: [{ detail: 'Forbidden' }] }, 403); });
    await assert.rejects(api.search('product'), error => error.status === 403);
    assert.equal(calls, 1);
    assert.ok(api.tokens);
});

test('Verspätete Retry-Antwort kann eine abgemeldete Sitzung nicht wiederherstellen', async t => {
    const api = setup();
    let complete;
    let requested;
    const retryStarted = new Promise(resolve => { requested = resolve; });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async url => {
        if (url.endsWith('/oauth/token')) return json({ access_token: 'new', refresh_token: 'next', expires_in: 600 });
        if (++requests === 1) return json({}, 401);
        requested();
        return new Promise(resolve => { complete = () => resolve(json({ data: { admin: true } })); });
    });
    const pending = api.loadUser();
    await retryStarted;
    api.clear();
    complete();
    await assert.rejects(pending);
    assert.equal(api.user, null);
    assert.equal(api.tokens, null);
});

test('Logout während Token-Refresh verwirft das verspätete Token', async t => {
    const api = setup();
    api.tokens.expiresAt = 0;
    let complete;
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => {
        complete = () => resolve(json({ access_token: 'new', refresh_token: 'next', expires_in: 600 }));
    }));
    const pending = api.search('product');
    api.clear();
    complete();
    await assert.rejects(pending);
    assert.equal(api.tokens, null);
});

test('Standardrechte gelten nur für angemeldete Benutzer und erlauben keine zusätzlichen Schreibzugriffe', () => {
    const storage = { getItem: () => null, removeItem: () => {} };
    const api = new AdminApi('/api', 'language', storage, ['currency:read', 'system:queue:process']);
    assert.equal(api.can('system:queue:process'), false);
    api.user = { admin: false, aclRoles: [{ privileges: ['product:read'] }] };
    assert.equal(api.can('currency:read'), true);
    assert.equal(api.can('system:queue:process'), true);
    assert.equal(api.can('product:read'), true);
    assert.equal(api.can('product:update'), false);
    api.clear();
    assert.equal(api.can('currency:read'), false);
});
