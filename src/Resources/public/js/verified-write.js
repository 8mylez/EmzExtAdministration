import { encode } from './ui.js';

export function verifiedWrite(api, path, method, payload) {
    if (api.isSso) return api.request(path, method, payload);
    return new Promise((resolve, reject) => {
        const generation = api.generation;
        let submitting = false;
        let completed = false;
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, items: [
            { xtype: 'component', html: '<p>Shopware benötigt dein aktuelles Passwort, um diese Änderung an Benutzern oder Rollen zu bestätigen.</p>' },
            { xtype: 'textfield', name: 'password', fieldLabel: 'Dein aktuelles Passwort', labelAlign: 'top', inputType: 'password', allowBlank: false, anchor: '100%' },
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
        ] });
        const dialog = Ext.create('Ext.window.Window', { title: 'Änderung bestätigen', modal: true, constrain: true,
            width: Math.min(540, window.innerWidth - 24), layout: 'fit', items: [form],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Bestätigen', cls: 'emz-admin__primary', handler: submit }],
            listeners: { beforeclose: () => !submitting, destroy: () => {
                if (!completed) reject(new Error('Änderung abgebrochen. Es wurde nichts bestätigt.'));
            } },
        });
        dialog.show();
        form.getForm().findField('password').focus();
        async function submit() {
            if (submitting || !form.getForm().isValid()) return;
            submitting = true; dialog.setLoading('Änderung wird bestätigt …');
            const password = form.getForm().findField('password');
            let authenticated = false;
            try {
                if (!api.user || api.generation !== generation) throw new Error('Bitte erneut anmelden.');
                const verified = await api.send('/oauth/token', 'POST', { client_id: 'administration', grant_type: 'password',
                    scope: 'user-verified', username: api.user.username, password: password.getValue() });
                authenticated = true;
                password.setValue('');
                if (!api.user || api.generation !== generation) throw new Error('Die Sitzung wurde inzwischen beendet.');
                const result = await api.send(path, method, payload, verified.access_token);
                // This short-lived token is deliberately not persisted or used to replace the login session.
                completed = true; dialog.destroy(); resolve(result);
            } catch (error) {
                if (authenticated) {
                    completed = true; dialog.destroy(); reject(error); return;
                }
                if (!dialog.destroyed) {
                    password.setValue('');
                    form.down('#error').update(encode([400, 401].includes(error.status) ? 'Passwort ungültig oder Sitzung abgelaufen.' : error.message));
                }
            } finally { submitting = false; if (!dialog.destroyed) dialog.setLoading(false); }
        }
    });
}
