import { AdminApi } from './api.js';
import { loginView } from './login.js';
import { desktopView } from './desktop.js';
import { showError } from './ui.js';
import { startAdminWorker } from './admin-worker.js';
import { importShopwareSession } from './sso.js';
import { recoveryHash } from './recovery.js';
import { registerAgencyModules } from './modules/agency.js';
import { modules } from './modules/index.js';

function start() {
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
    const loading = document.getElementById('emz-admin-loading');
    if (!window.Ext) {
        loading.textContent = 'Ext JS konnte nicht geladen werden. Bitte die SDK-Installation prüfen.';
        return;
    }
    Ext.onReady(() => {
        Ext.enableFx = false;
        Ext.Ajax.setDefaultHeaders({ Accept: 'application/json' });
        const config = document.getElementById('emz-admin-config').dataset;
        const api = new AdminApi(config.apiBase, config.languageId, window.sessionStorage, JSON.parse(config.defaultPrivileges || '[]'));
        importShopwareSession(api, config.nativeUrl);
        const viewport = Ext.create('Ext.container.Viewport', { layout: 'fit', items: [] });
        loading.remove();
        let desktop;
        let stopWorker = () => {};
        const showLogin = (message = '') => {
            stopWorker();
            Ext.WindowManager.each(dialog => {
                if (dialog === Ext.Msg) dialog.hide();
                else if (!dialog.destroyed) dialog.destroy();
            });
            viewport.removeAll(true);
            desktop = null;
            viewport.add(loginView(api, showShell, message, config.logoUrl));
        };
        api.onExpired = () => showLogin('Deine Sitzung ist abgelaufen. Bitte erneut anmelden.');

        function navigate(page) {
            desktop?.open(page);
        }

        async function showShell() {
            await registerAgencyModules(api, modules);
            if (!api.user) return;
            stopWorker();
            stopWorker = startAdminWorker(api);
            viewport.removeAll(true);
            desktop = desktopView(api, config, async button => {
                button.disable();
                stopWorker();
                try { await api.logout(); } catch (error) { showError(error); }
                showLogin();
            });
            viewport.add(desktop.component);
            navigate(window.location.hash.slice(1) || 'dashboard');
        }
        window.addEventListener('hashchange', () => {
            if (!desktop && recoveryHash()) showLogin();
            else navigate(window.location.hash.slice(1) || 'dashboard');
        });
        if (!api.tokens) {
            showLogin();
            return;
        }
        viewport.setLoading('Sitzung wird geprüft …');
        api.loadUser().then(showShell).catch(error => {
            api.clear();
            showLogin(error.status === 401 ? 'Bitte erneut anmelden.' : error.message);
        }).finally(() => viewport.setLoading(false));
    });
}

if (document.readyState === 'complete') start();
else window.addEventListener('load', start, { once: true });
