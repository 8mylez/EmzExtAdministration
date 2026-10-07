import { openEntityEditor } from '../entity-editor.js';
import { encode, notify, showError } from '../ui.js';

export const integrationsModule = {
    id: 'integrations', title: 'Integrationen', singular: 'Integration', entity: 'integration', group: 'Einstellungen', icon: 'x-fa fa-plug',
    search: ['label'], sort: 'label', direction: 'ASC', labelFields: ['label'], associations: { app: {} }, editAssociations: { aclRoles: {}, app: {} },
    filter: [{ type: 'equals', field: 'deletedAt', value: null }], isLocked: record => Boolean(record?.app),
    columns: [{ field: 'label', label: 'Name' }, { field: 'admin', label: 'Administrator', type: 'boolean', width: 140 }, { field: 'lastUsageAt', label: 'Zuletzt verwendet', type: 'date', width: 200 }],
    fields: [{ name: 'label', label: 'Name', required: true }, { name: 'admin', label: 'Administratorzugriff', type: 'boolean' },
        { name: 'accessKey', label: 'Zugangs-ID', readOnly: true }, { name: 'secretAccessKey', label: 'Geheimer Schlüssel (nur jetzt verfügbar)', readOnly: true, createOnly: true },
        { name: 'roleIds', label: 'Rollen', type: 'reference', multiple: true, reference: { entity: 'acl_role' }, initialValue: record => record.aclRoles?.map(role => role.id) || [] }],
    editor: async (api, config, definition, id, onSaved) => {
        let defaults = {};
        if (!id) {
            try { defaults = await api.request('/_action/access-key/intergration'); }
            catch (error) { if (api.user) showError(error); return; }
        }
        let removedRoles = [];
        return openEntityEditor(api, config, { ...definition, defaults,
            fields: definition.fields.map(field => field.name === 'admin' ? { ...field, readOnly: !api.user?.admin } : field),
            prepare: (payload, original) => {
                if (!api.user?.admin) delete payload.admin;
                if ('roleIds' in payload) {
                    removedRoles = (original?.aclRoles || []).filter(role => !payload.roleIds.includes(role.id)).map(role => role.id);
                    payload.aclRoles = payload.roleIds.map(roleId => ({ id: roleId })); delete payload.roleIds;
                }
                return payload;
            },
            write: async (api, path, method, payload) => {
                await api.request(path, method, payload);
                for (const roleId of removedRoles) await api.request(`${path}/acl-roles/${roleId}`, 'DELETE');
            },
        }, id, onSaved);
    },
    detailTabs: (api, config, record) => [Ext.create('Ext.panel.Panel', { title: 'Zugang erneuern', bodyPadding: 20, items: [
        { xtype: 'component', html: '<p>Neue Zugangsschlüssel ersetzen den bisherigen Zugang. Den neuen geheimen Schlüssel vor dem Speichern sicher übernehmen; er wird danach nicht mehr angezeigt.</p>' },
        { xtype: 'button', text: 'Neue Zugangsschlüssel vorbereiten', disabled: Boolean(record.app) || !api.can('integration:update') || !api.can('api_action_access-key_integration'),
            handler: () => rotateKeys(api, record) },
    ] })],
};

async function rotateKeys(api, record) {
    let keys;
    try { keys = await api.request('/_action/access-key/intergration'); }
    catch (error) { if (api.user) showError(error); return; }
    if (!api.user) return;
    let saving = false;
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, defaults: { xtype: 'textfield', anchor: '100%', labelAlign: 'top', readOnly: true }, items: [
        { fieldLabel: 'Neue Zugangs-ID', value: keys.accessKey }, { fieldLabel: 'Neuer geheimer Schlüssel (nur jetzt verfügbar)', value: keys.secretAccessKey },
        { xtype: 'checkboxfield', name: 'confirm', readOnly: false, boxLabel: 'Ich habe den neuen Zugang übernommen. Der bisherige Zugang darf ungültig werden.' },
        { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
    ] });
    const dialog = Ext.create('Ext.window.Window', { title: 'Integrationszugang erneuern', modal: true, width: Math.min(700, window.innerWidth - 24), layout: 'fit', items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Zugang ersetzen', handler: async () => {
            if (saving || !form.getForm().findField('confirm').getValue()) return;
            saving = true; dialog.setLoading('Zugang wird erneuert …');
            try { await api.request(`/integration/${record.id}`, 'PATCH', keys); dialog.destroy(); notify('Integrationszugang erneuert.'); }
            catch (error) { if (!dialog.destroyed && api.user) form.down('#error').update(encode(error.message)); }
            finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
        } }], listeners: { beforeclose: () => !saving },
    }); dialog.show();
}
