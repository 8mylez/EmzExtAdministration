export function readShopwareAuthCookie(cookie) {
    const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('bearerAuth='));
    if (!value) return null;
    try {
        const auth = JSON.parse(decodeURIComponent(value.slice('bearerAuth='.length)));
        if (typeof auth.access !== 'string' || typeof auth.refresh !== 'string' || !Number.isFinite(auth.expiry) || auth.expiry <= Date.now()) return null;
        return { access_token: auth.access, refresh_token: auth.refresh, expires_in: (auth.expiry - Date.now()) / 1000 };
    } catch { return null; }
}

export function importShopwareSession(api, nativeUrl) {
    const cookie = readShopwareAuthCookie(document.cookie);
    const path = new URL(nativeUrl, location.href).pathname.replace(/\/$/, '') || '/';
    document.cookie = `bearerAuth=; Max-Age=0; Path=${path}; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
    if (cookie) api.saveTokens(cookie, api.generation);
}

export async function openNativeAdministration(api, nativeUrl, route = '') {
    const target = new URL(nativeUrl, location.href);
    if (target.origin !== location.origin) throw new Error('Die Shopware-Administration muss zum selben Shop gehören.');
    // Verify the session and refresh its access token before handing it to Shopware's native login service.
    await api.request('/_info/me');
    if (!api.tokens || !api.user) throw new Error('Bitte erneut anmelden.');
    const auth = { access: api.tokens.access_token, refresh: api.tokens.refresh_token, expiry: api.tokens.expiresAt };
    const path = target.pathname.replace(/\/$/, '') || '/';
    document.cookie = `bearerAuth=${encodeURIComponent(JSON.stringify(auth))}; Path=${path}; SameSite=Strict; Expires=${new Date(auth.expiry).toUTCString()}${target.protocol === 'https:' ? '; Secure' : ''}`;
    if (route) target.hash = route;
    api.clear();
    location.assign(target.href);
}
