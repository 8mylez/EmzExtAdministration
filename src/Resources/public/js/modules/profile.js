import { entityField, formValues, errorHtml } from '../entity-fields.js';
import { verifiedWrite } from '../verified-write.js';
import { notify } from '../ui.js';

function profileView(api) {
    const writable = api.can('user_change_me');
    const fields = [
        { name: 'firstName', label: 'Vorname', required: true }, { name: 'lastName', label: 'Nachname', required: true },
        { name: 'username', label: 'Benutzername', required: true }, { name: 'email', label: 'E-Mail', type: 'email', required: true },
        { name: 'localeId', label: 'Kontosprache', type: 'reference', required: true, reference: { entity: 'locale', labelFields: ['code', 'name'] } },
        { name: 'timeZone', label: 'Zeitzone', type: 'select', options: [...new Set([api.user.timeZone || 'UTC', 'UTC', ...Intl.supportedValuesOf('timeZone')])].map(zone => [zone, zone]) },
        { name: 'avatarId', label: 'Profilbild', type: 'reference', reference: { entity: 'media', labelFields: ['fileName'], filter: [{ type: 'contains', field: 'mimeType', value: 'image/' }] } },
        ...(!api.isSso ? [{ name: 'password', label: 'Neues Passwort (leer lassen zum Beibehalten)', type: 'password' },
            { name: 'passwordConfirm', label: 'Neues Passwort wiederholen', type: 'password' }] : []),
    ];
    let saving = false;
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 24, scrollable: true,
        items: fields.map(field => entityField(api, field, api.user[field.name], writable))
            .concat([{ xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' }]),
        bbar: ['->', { text: 'Profil speichern', cls: 'emz-admin__primary', disabled: !writable, handler: save }],
    });
    form.getForm().getFields().each(field => field.resetOriginalValue());
    async function save() {
        if (saving || !writable || !form.getForm().isValid()) return;
        const { values, dirty } = formValues(form, fields);
        if (values.password !== values.passwordConfirm) { form.down('#error').update('Die neuen Passwörter stimmen nicht überein.'); return; }
        const payload = Object.fromEntries([...dirty].filter(name => name !== 'passwordConfirm' && (name !== 'password' || values.password)).map(name => [name, values[name]]));
        if (!Object.keys(payload).length) return;
        saving = true;
        try {
            await verifiedWrite(api, '/_info/me', 'PATCH', payload);
            await api.loadUser();
            if (form.destroyed) return;
            form.getForm().findField('password')?.setValue(''); form.getForm().findField('passwordConfirm')?.setValue('');
            form.getForm().getFields().each(field => field.resetOriginalValue()); form.down('#error').update('');
            notify('Profil gespeichert.');
        } catch (error) { if (!form.destroyed && api.user) form.down('#error').update(errorHtml(error)); }
        finally { saving = false; }
    }
    return form;
}

export const profileModule = { id: 'profile', title: 'Mein Profil', entity: 'user', access: api => Boolean(api.user), icon: 'x-fa fa-user', view: profileView };
