import { encode } from './ui.js';
import { openRecovery, recoveryHash } from './recovery.js';

export function loginView(api, onLogin, message = '', logoUrl) {
    let submitting = false;
    const submit = async () => {
        const form = panel.getForm();
        if (submitting || !form.isValid()) return;
        submitting = true;
        panel.setLoading('Anmeldung läuft …');
        const values = form.getValues();
        try {
            await api.login(values.username.trim(), values.password);
            form.findField('password').reset();
            await onLogin();
        } catch (error) {
            if (!panel.destroyed) {
                panel.down('#error').update(encode(error.status === 400 || error.status === 401
                    ? 'Benutzername oder Passwort ist ungültig.' : error.message));
                form.findField('password').reset();
                form.findField('password').focus();
            }
        } finally {
            submitting = false;
            if (!panel.destroyed) panel.setLoading(false);
        }
    };
    const panel = Ext.create('Ext.form.Panel', {
        width: Math.min(360, window.innerWidth - 24), height: 480, bodyPadding: '112 40 20', cls: 'emz-admin__login',
        header: false, border: false, ariaLabel: 'Anmeldung',
        defaults: { anchor: '100%', labelAlign: 'top', allowBlank: false, xtype: 'textfield' },
        items: [
            { xtype: 'component', html: `<div class="emz-admin__login-brand" role="img" aria-label="Shopware 6"><img src="${encode(logoUrl)}" alt=""><span aria-hidden="true">6</span></div><h1 class="emz-admin__login-title">Willkommen im Backend</h1>` },
            { name: 'username', fieldLabel: 'Benutzername', inputAttrTpl: 'autocomplete="username"',
                listeners: { afterrender: field => field.focus() } },
            { name: 'password', fieldLabel: 'Passwort', inputType: 'password', inputAttrTpl: 'autocomplete="current-password"',
                listeners: { specialkey: (field, event) => { if (event.getKey() === event.ENTER) submit(); } } },
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error', html: encode(message) },
            { xtype: 'button', text: 'Anmelden', itemId: 'passwordLogin', cls: 'emz-admin__primary', margin: '14 0 0', handler: submit },
            { xtype: 'button', text: 'Passwort vergessen?', itemId: 'recovery', margin: '8 0 0', handler: () => openRecovery(api) },
            { xtype: 'button', text: 'Mit Single Sign-on anmelden', itemId: 'sso', margin: '8 0 0', hidden: true },
        ],
        listeners: { afterrender: async () => {
            const hash = recoveryHash(); if (hash) openRecovery(api, hash);
            try {
                const sso = await api.send('/oauth/sso/config', 'GET');
                if (panel.destroyed || !sso.url) return;
                const url = new URL(sso.url, location.href);
                if (url.origin !== location.origin) throw new Error('Die Single-Sign-on-Adresse passt nicht zu diesem Shop.');
                panel.down('#sso').setHandler(() => { location.href = url.href; }); panel.down('#sso').show();
                if (!sso.useDefault) {
                    panel.getForm().getFields().each(field => field.hide());
                    panel.down('#passwordLogin').hide(); panel.down('#recovery').hide();
                } else panel.setHeight(525);
                if (location.hash === '#/sso/error') panel.down('#error').update('Dieses SSO-Konto ist für den Shop nicht freigeschaltet.');
            } catch (error) { if (!panel.destroyed) panel.down('#error').update(encode(error.message)); }
        } },
    });
    return Ext.create('Ext.container.Container', {
        cls: 'emz-admin__login-screen', scrollable: true,
        layout: { type: 'vbox', align: 'center', pack: 'center' }, items: [panel,
            { xtype: 'component', cls: 'emz-admin__login-credit', html: '8mylez · Demo zum Spaß<br>Nicht für den Produktiveinsatz gedacht.', margin: '12 0 0' }],
    });
}
