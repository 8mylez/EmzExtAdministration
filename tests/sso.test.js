import test from 'node:test';
import assert from 'node:assert/strict';
import { readShopwareAuthCookie } from '../src/Resources/public/js/sso.js';

test('SSO-Callback übernimmt nur vollständige gültige Shopware-Sitzungen', () => {
    const cookie = data => `other=value; bearerAuth=${encodeURIComponent(JSON.stringify(data))}`;
    assert.equal(readShopwareAuthCookie('bearerAuth=%broken'), null);
    assert.equal(readShopwareAuthCookie(cookie({ access: 'a', expiry: Date.now() + 50000 })), null);
    assert.equal(readShopwareAuthCookie(cookie({ access: 'a', refresh: 'r', expiry: Date.now() - 1 })), null);
    const result = readShopwareAuthCookie(cookie({ access: 'a', refresh: 'r', expiry: Date.now() + 50000 }));
    assert.equal(result.access_token, 'a'); assert.equal(result.refresh_token, 'r'); assert.ok(result.expires_in > 49);
});
