export class ApiError extends Error {
    constructor(message, status = 0, errors = []) {
        super(message);
        this.status = status;
        this.errors = errors;
    }
}

export class AdminApi {
    constructor(baseUrl, languageId, storage = window.sessionStorage, defaultPrivileges = []) {
        this.baseUrl = baseUrl;
        this.languageId = languageId;
        this.storage = storage;
        this.defaultPrivileges = new Set(defaultPrivileges);
        this.key = `emz.ext-admin.session:${baseUrl}`;
        this.generation = 0;
        this.user = null;
        this.onExpired = () => {};
        try {
            this.tokens = JSON.parse(storage.getItem(this.key)) || null;
        } catch {
            this.tokens = null;
        }
    }

    async send(path, method, body, token, options = {}) {
        let response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                method,
                credentials: 'same-origin',
                headers: {
                    Accept: 'application/json',
                    ...(options.contentType === null ? {} : { 'Content-Type': options.contentType || 'application/json' }),
                    'sw-language-id': this.languageId,
                    ...(options.headers || {}),
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: body === undefined ? undefined : options.rawBody ? body : JSON.stringify(body),
            });
        } catch {
            throw new ApiError('Der Shop ist nicht erreichbar. Bitte Verbindung prüfen und erneut versuchen.');
        }
        const data = response.ok && options.responseType === 'blob' ? await response.blob()
            : response.status === 204 ? null : await response.json().catch(() => null);
        if (!response.ok) {
            const message = data?.errors?.map(error => error.detail || error.title).join('\n');
            throw new ApiError(message || data?.error_description || `Anfrage fehlgeschlagen (${response.status}).`, response.status, data?.errors || []);
        }
        return data;
    }

    saveTokens(tokens, generation) {
        if (generation !== this.generation) {
            throw new ApiError('Diese Sitzung wurde beendet.', 401);
        }
        this.tokens = { ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 };
        this.storage.setItem(this.key, JSON.stringify(this.tokens));
    }

    clear() {
        this.generation += 1;
        this.tokens = null;
        this.user = null;
        this.storage.removeItem(this.key);
    }

    async login(username, password) {
        this.clear();
        const generation = this.generation;
        const tokens = await this.send('/oauth/token', 'POST', {
            grant_type: 'password', client_id: 'administration', scope: 'write', username, password,
        });
        this.saveTokens(tokens, generation);
        try {
            await this.loadUser();
        } catch (error) {
            this.clear();
            throw error;
        }
    }

    async refresh() {
        if (this.refreshing) return this.refreshing;
        const generation = this.generation;
        const refreshToken = this.tokens?.refresh_token;
        this.refreshing = (async () => {
            try {
                if (!refreshToken) throw new ApiError('Bitte erneut anmelden.', 401);
                const tokens = await this.send('/oauth/token', 'POST', {
                    grant_type: 'refresh_token', client_id: 'administration', scope: 'write', refresh_token: refreshToken,
                });
                this.saveTokens(tokens, generation);
            } catch (error) {
                if ([400, 401].includes(error.status) && generation === this.generation) {
                    this.clear();
                    this.onExpired();
                }
                throw error;
            }
        })();
        try {
            await this.refreshing;
        } finally {
            this.refreshing = null;
        }
    }

    async request(path, method = 'GET', body, options = {}) {
        if (!this.tokens) throw new ApiError('Bitte anmelden.', 401);
        if (this.tokens.expiresAt < Date.now() + 30000) await this.refresh();
        const generation = this.generation;
        const token = this.tokens?.access_token;
        try {
            const data = await this.send(path, method, body, token, options);
            if (generation !== this.generation) throw new ApiError('Diese Sitzung wurde beendet.', 401);
            return data;
        } catch (error) {
            if (error.status !== 401 || generation !== this.generation) throw error;
            if (token === this.tokens?.access_token) await this.refresh();
            try {
                const data = await this.send(path, method, body, this.tokens?.access_token, options);
                if (generation !== this.generation) throw new ApiError('Diese Sitzung wurde beendet.', 401);
                return data;
            } catch (retryError) {
                if (retryError.status === 401 && generation === this.generation) {
                    this.clear();
                    this.onExpired();
                }
                throw retryError;
            }
        }
    }

    async loadUser() {
        const response = await this.request('/_info/me');
        const sso = await this.request('/_info/is-sso');
        this.isSso = Boolean(sso.isSso);
        this.user = response.data;
    }

    can(privilege) {
        return Boolean(this.user && (this.user.admin || this.defaultPrivileges.has(privilege)
            || this.user.aclRoles?.some(role => role.privileges?.includes(privilege))));
    }

    search(entity, criteria = {}, options = {}) {
        return this.request(`/search/${entity}`, 'POST', { page: 1, limit: 25, 'total-count-mode': 1, ...criteria }, options);
    }

    async logout() {
        try {
            await this.request('/_action/user/logout', 'POST', {});
        } finally {
            this.clear();
        }
    }
}
