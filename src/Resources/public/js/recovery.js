import { encode } from './ui.js';
import { entityField } from './entity-fields.js';

export function recoveryHash() {
    return window.location.hash.match(/^#\/login\/user-recovery\/([a-zA-Z0-9]+)$/)?.[1];
}

export function openRecovery(api, hash) {
    let submitting = false;
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 24, defaults: { xtype: 'textfield', labelAlign: 'top', anchor: '100%', allowBlank: false }, items: [
        { xtype: 'component', html: hash ? '<p>Lege ein neues Passwort für dein Konto fest.</p>' : '<p>Gib die E-Mail-Adresse deines Benutzerkontos ein. Du erhältst einen Link zum Zurücksetzen des Passworts.</p>' },
        ...(hash ? [
            { name: 'password', fieldLabel: 'Neues Passwort', inputType: 'password', inputAttrTpl: 'autocomplete="new-password"' },
            { name: 'passwordConfirm', fieldLabel: 'Neues Passwort wiederholen', inputType: 'password', inputAttrTpl: 'autocomplete="new-password"' },
        ] : [entityField(api, { name: 'email', label: 'E-Mail', type: 'email', required: true }, '', true)]),
        { xtype: 'component', itemId: 'message', ariaRole: 'status' },
    ] });
    const dialog = Ext.create('Ext.window.Window', { title: 'Passwort zurücksetzen', modal: true, constrain: true,
        width: Math.min(480, window.innerWidth - 24), layout: 'fit', items: [form],
        buttons: [{ text: 'Schließen', handler: () => dialog.close() }, { text: hash ? 'Passwort speichern' : 'Link anfordern', itemId: 'submit', cls: 'emz-admin__primary', handler: submit }],
        listeners: { beforeclose: () => !submitting },
    });
    dialog.show();
    async function submit() {
        if (submitting || !form.getForm().isValid()) return;
        const values = form.getForm().getValues();
        if (hash && values.password !== values.passwordConfirm) { form.down('#message').update('Die Passwörter stimmen nicht überein.'); return; }
        submitting = true; dialog.setLoading('Anfrage wird verarbeitet …');
        try {
            await api.send(hash ? '/_action/user/user-recovery/password' : '/_action/user/user-recovery', hash ? 'PATCH' : 'POST', hash ? { hash, ...values } : { email: values.email.trim() });
            form.getForm().reset(); dialog.down('#submit').hide();
            if (hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
            form.down('#message').update(hash ? 'Das Passwort wurde geändert. Du kannst dich jetzt anmelden.' : 'Wenn ein passendes Konto existiert, wurde ein Link zum Zurücksetzen angefordert.');
        } catch (error) {
            form.down('#message').update(encode(hash && error.status === 400 && !error.errors?.length ? 'Der Link ist ungültig oder abgelaufen. Bitte einen neuen Link anfordern.' : error.message));
        } finally { submitting = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}
