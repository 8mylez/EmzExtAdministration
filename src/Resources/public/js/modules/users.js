import { openEntityEditor } from '../entity-editor.js';
import { entityListView } from '../entity-list.js';
import { entityField } from '../entity-fields.js';
import { verifiedWrite } from '../verified-write.js';
import { encode, notify, showError } from '../ui.js';

const userModule = {
    id: 'users', title: 'Benutzer', singular: 'Benutzer', entity: 'user', group: 'System', icon: 'x-fa fa-user',
    search: ['username', 'firstName', 'lastName', 'email'], sort: 'username', direction: 'ASC', activeFilter: true, labelFields: ['username'],
    columns: [{ field: 'username', label: 'Benutzername' }, { field: 'firstName', label: 'Vorname' }, { field: 'lastName', label: 'Nachname' },
        { field: 'active', label: 'Aktiv', type: 'boolean', width: 90 }, { field: 'admin', label: 'Administrator', type: 'boolean', width: 130 }],
    fields: [
        { name: 'username', label: 'Benutzername', required: true }, { name: 'firstName', label: 'Vorname', required: true },
        { name: 'lastName', label: 'Nachname', required: true }, { name: 'email', label: 'E-Mail', required: true, type: 'email' },
        { name: 'password', label: 'Neues Passwort (leer = beibehalten)', type: 'password' },
        { name: 'active', label: 'Aktiv', type: 'boolean' }, { name: 'admin', label: 'Administrator', type: 'boolean' },
        { name: 'localeId', label: 'Oberflächensprache', type: 'reference', required: true, reference: { entity: 'locale', labelFields: ['code', 'name'] } },
        { name: 'timeZone', label: 'Zeitzone', required: true, default: 'Europe/Berlin' },
    ],
    write: verifiedWrite,
    editor: (api, config, definition, id, onSaved) => openEntityEditor(api, config, { ...definition,
        fields: definition.fields.map(field => field.name === 'admin' ? { ...field, readOnly: !api.user.admin }
            : field.name === 'password' ? { ...field, required: !id, label: id ? field.label : 'Initiales Passwort' } : field),
        detailTabs: (api, config, user) => api.can('acl_role:read') ? [userRoles(api, config, user)] : [],
    }, id, onSaved),
};

const roleModule = {
    id: 'roles', title: 'Rollen & Berechtigungen', singular: 'Rolle', entity: 'acl_role', group: 'System', icon: 'x-fa fa-lock',
    search: ['name'], sort: 'name', direction: 'ASC', write: verifiedWrite,
    columns: [{ field: 'name', label: 'Rolle' }, { field: 'description', label: 'Beschreibung' }],
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Beschreibung', type: 'textarea' }],
    editor: async (api, config, definition, id, onSaved) => {
        try {
            const canReadPrivileges = api.can('api_acl_privileges_get');
            const privileges = canReadPrivileges ? await api.request('/_action/acl/privileges') : [];
            await openEntityEditor(api, config, { ...definition, fields: [...definition.fields, {
                name: 'privileges', label: canReadPrivileges ? 'Berechtigungen auswählen' : 'Berechtigungen (keine Berechtigung zum Lesen der Auswahl)',
                type: canReadPrivileges ? 'multiselect' : 'lines', readOnly: !canReadPrivileges,
                options: [...new Set(Object.values(privileges))].sort().map(privilege => [privilege, privilege]),
            }] }, id, onSaved);
        } catch (error) { if (api.user) showError(error); }
    },
};

function userRoles(api, config, user) {
    const panel = entityListView(api, config, { ...roleModule, title: 'Zugeordnete Rollen', create: false, delete: false,
        filter: [{ type: 'equals', field: 'users.id', value: user.id }] });
    panel.setTitle('Rollen');
    panel.addDocked({ xtype: 'toolbar', dock: 'top', items: [
        { text: 'Rolle zuordnen', disabled: !api.can('user:update') || !api.can('acl_user_role:create'), handler: assign },
        { text: 'Rolle entziehen', disabled: !api.can('acl_user_role:delete'), handler: () => {
            const role = panel.getSelection()[0];
            if (!role) return;
            Ext.Msg.confirm('Rolle entziehen?', `„${encode(role.get('name'))}“ wird diesem Benutzer entzogen.`, async answer => {
                if (answer !== 'yes') return;
                try { await verifiedWrite(api, `/user/${user.id}/acl-roles/${role.id}`, 'DELETE'); if (!panel.destroyed) panel.refreshRecords(); }
                catch (error) { if (api.user) showError(error); }
            });
        } },
    ] });
    function assign() {
        const select = entityField(api, { name: 'role', label: 'Rolle', type: 'reference', required: true, reference: { entity: 'acl_role' } }, null, true);
        let saving = false;
        const dialog = Ext.create('Ext.window.Window', { title: 'Rolle zuordnen', modal: true, bodyPadding: 20, width: Math.min(540, window.innerWidth - 24),
            items: [select], buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Zuordnen', cls: 'emz-admin__primary', handler: async () => {
                if (saving || !select.isValid()) return;
                saving = true;
                try {
                    await verifiedWrite(api, `/user/${user.id}`, 'PATCH', { aclRoles: [{ id: select.getValue() }] });
                    dialog.destroy(); notify('Rolle zugeordnet.'); if (!panel.destroyed) panel.refreshRecords();
                } catch (error) { if (api.user) showError(error); }
                finally { saving = false; }
            } }], listeners: { beforeclose: () => !saving },
        });
        dialog.show();
    }
    return panel;
}

export const userModules = [userModule, roleModule];
