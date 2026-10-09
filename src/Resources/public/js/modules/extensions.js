import { configView } from './system-config.js';
import { encode, notify, showError } from '../ui.js';
import { openNativeAdministration } from '../sso.js';

const labels = { install: 'Installieren', activate: 'Aktivieren', deactivate: 'Deaktivieren', update: 'Aktualisieren', uninstall: 'Deinstallieren', remove: 'Dateien entfernen' };
function extensionView(api, config) {
    let busy = false; let enabled = false; let records = [];
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'name', 'label', 'version', 'type', 'active', 'installedAt', 'managedByComposer', 'raw'] });
    const grid = Ext.create('Ext.grid.Panel', { store, emptyText: 'Keine Erweiterungen vorhanden.', viewConfig: { deferEmptyText: false },
        columns: [{ text: 'Erweiterung', dataIndex: 'label', flex: 1, renderer: encode }, { text: 'Name', dataIndex: 'name', flex: 1, renderer: encode },
            { text: 'Typ', dataIndex: 'type', width: 80, renderer: encode }, { text: 'Version', dataIndex: 'version', width: 120, renderer: encode },
            { text: 'Installiert', dataIndex: 'installedAt', width: 100, renderer: value => value ? 'Ja' : 'Nein' }, { text: 'Aktiv', dataIndex: 'active', width: 80, renderer: value => value ? 'Ja' : 'Nein' }],
        tbar: { enableOverflow: true, items: [{ xtype: 'textfield', ariaLabel: 'Erweiterungen suchen', emptyText: 'Erweiterungen suchen …', width: 250, listeners: { change: (field, value) => filter(value) } },
            { text: 'Liste laden', handler: load }, { text: 'Dateien einlesen', itemId: 'refresh', disabled: true, handler: () => run('/_action/extension/refresh', 'POST', {}) },
            { text: 'ZIP hochladen', itemId: 'upload', disabled: true, handler: upload },
            { text: 'Shopware Store öffnen', tooltip: 'Öffnet den offiziellen Store in der Shopware-Administration mit deiner bestehenden Sitzung.',
                handler: () => openNativeAdministration(api, config.nativeUrl, '/sw/extension/store').catch(showError) } ] },
        dockedItems: [{ xtype: 'toolbar', dock: 'top', enableOverflow: true, items: [
            ...Object.entries(labels).map(([action, text]) => ({ text, itemId: action, disabled: true, handler: () => confirmAction(action) })),
            { text: 'Konfiguration', itemId: 'config', disabled: true, handler: configure }, { text: 'Details', itemId: 'details', disabled: true, handler: details },
            { text: 'App-Berechtigungen', itemId: 'permissions', disabled: true, handler: permissions },
        ] }],
        bbar: [{ xtype: 'tbtext', itemId: 'status', text: 'Erweiterungen werden geladen …' }],
        listeners: { afterrender: load, selectionchange: controls, itemdblclick: details, destroy: () => store.destroy() },
    });
    function selected() { return grid.getSelection()[0]?.get('raw'); }
    function filter(term = '') {
        const search = term.toLocaleLowerCase(); store.loadData(records.filter(row => `${row.name} ${row.label}`.toLocaleLowerCase().includes(search))
            .map(row => ({ ...row, id: `${row.type}:${row.name}`, label: row.label || row.name, raw: row })));
    }
    function controls() {
        if (grid.destroyed) return;
        const row = selected(); const installed = Boolean(row?.installedAt); const allowed = enabled && !busy && Boolean(row);
        for (const [action, can] of Object.entries({ install: !installed, activate: installed && !row?.active, deactivate: row?.active && row.allowDisable !== false,
            update: installed && row?.allowUpdate && row?.latestVersion && row.latestVersion !== row.version && !row.managedByComposer,
            uninstall: installed && row?.allowDisable !== false, remove: !installed && !row?.managedByComposer })) grid.down(`#${action}`).setDisabled(!allowed || !can);
        grid.down('#config').setDisabled(!row?.configurable || !api.can('system_config:read') || busy);
        grid.down('#details').setDisabled(!row || busy); grid.down('#permissions').setDisabled(row?.type !== 'app' || !installed || !api.can('app:read') || !api.can('acl_role:read') || busy);
        grid.down('#refresh').setDisabled(!enabled || busy); grid.down('#upload').setDisabled(!enabled || !api.can('system.plugin_upload') || busy);
    }
    async function load() {
        if (grid.destroyed || !api.user) return;
        grid.setLoading('Erweiterungen werden geladen …');
        try {
            const [data, info] = await Promise.all([api.request('/_action/extension/installed'), api.request('/_info/config')]);
            if (grid.destroyed) return;
            records = Object.values(data); enabled = !info.settings?.disableExtensionManagement && api.can('system.plugin_maintain'); filter();
            grid.down('#status').setText(enabled ? `${records.length} Erweiterungen · Änderungen können einen Neuladevorgang erfordern.` : 'Die Laufzeitverwaltung von Erweiterungen ist in diesem Shop deaktiviert.');
            controls();
        } catch (error) { if (!grid.destroyed && api.user) showError(error); }
        finally { if (!grid.destroyed) grid.setLoading(false); }
    }
    async function run(path, method, payload, options) {
        if (busy) return false; busy = true; controls(); grid.setLoading('Erweiterung wird verarbeitet …');
        try { await api.request(path, method, payload, options); notify('Erweiterung verarbeitet.'); await load(); return true; }
        catch (error) { if (!grid.destroyed && api.user) showError(error); return false; }
        finally { busy = false; if (!grid.destroyed) { grid.setLoading(false); controls(); } }
    }
    function confirmAction(action) {
        const row = selected(); if (!row || busy || !enabled) return;
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, items: [
            { xtype: 'component', html: `<p>„${encode(row.label || row.name)}“: ${encode(labels[action])}?</p>` },
            ...(['uninstall', 'remove'].includes(action) ? [{ xtype: 'checkboxfield', name: 'keepUserData', boxLabel: 'Daten der Erweiterung behalten', checked: true }] : []),
            ...(row.type === 'app' && ['install', 'update', 'activate'].includes(action) ? [
                { xtype: 'component', html: `<p>Berechtigungen und angeforderte Rechte:</p><pre>${encode(JSON.stringify({ permissions: row.permissions, requestedPermissions: row.requestedPermissions }, null, 2))}</pre>` },
                { xtype: 'checkboxfield', name: 'accept', boxLabel: 'Angezeigte App-Berechtigungen bestätigen', checked: false, validator: value => value === true || 'Bitte die Berechtigungen bestätigen.' },
            ] : []),
        ] });
        const dialog = Ext.create('Ext.window.Window', { title: `Erweiterung: ${labels[action]}`, width: Math.min(620, innerWidth - 24), maxHeight: innerHeight - 32, modal: true, constrain: true, layout: 'fit', items: [form],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: labels[action], cls: 'emz-admin__primary', handler: async () => {
                if (!form.getForm().isValid()) return;
                const values = form.getForm().getFieldValues(); dialog.hide();
                const success = await run(`/_action/extension/${action}/${encodeURIComponent(row.type)}/${encodeURIComponent(row.name)}`, ['activate', 'deactivate'].includes(action) ? 'PUT' : 'POST',
                    { ...(['uninstall', 'remove'].includes(action) ? { keepUserData: values.keepUserData } : {}), ...(action === 'update' ? { allowNewPermissions: Boolean(values.accept) } : {}) });
                dialog.destroy(); if (success && row.name === 'EmzExtAdministration') location.reload();
            } }],
        }); dialog.show();
    }
    function configure() {
        const row = selected(); if (!row) return;
        Ext.create('Ext.window.Window', { title: `Konfiguration: ${row.label || row.name}`, modal: true, constrain: true, layout: 'fit', width: Math.min(880, innerWidth - 24), height: Math.min(760, innerHeight - 32),
            items: [configView(api, `${row.name}.config`)] }).show();
    }
    function details() {
        const row = selected(); if (!row) return;
        Ext.create('Ext.window.Window', { title: `Erweiterung: ${row.label || row.name}`, modal: true, constrain: true, width: Math.min(700, innerWidth - 24), height: Math.min(650, innerHeight - 32), bodyPadding: 20, scrollable: true,
            html: `<p>${encode(row.description || row.shortDescription || '')}</p><dl><dt>Hersteller</dt><dd>${encode(row.producerName || '—')}</dd><dt>Lizenz</dt><dd>${encode(row.license || '—')}</dd><dt>Composer-Verwaltung</dt><dd>${row.managedByComposer ? 'Ja' : 'Nein'}</dd></dl><pre>${encode(JSON.stringify({ permissions: row.permissions, requestedPermissions: row.requestedPermissions, notices: row.notices }, null, 2))}</pre>` }).show();
    }
    function upload() {
        const field = Ext.create('Ext.form.field.File', { name: 'file', fieldLabel: 'ZIP-Datei', labelAlign: 'top', anchor: '100%', buttonText: 'Auswählen …', allowBlank: false });
        const dialog = Ext.create('Ext.window.Window', { title: 'Erweiterung hochladen', modal: true, constrain: true, width: Math.min(540, innerWidth - 24), bodyPadding: 20, layout: 'anchor', items: [field],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Hochladen', cls: 'emz-admin__primary', handler: async () => {
                const file = field.fileInputEl.dom.files[0]; if (!file) return;
                if (!file.name.toLowerCase().endsWith('.zip')) { showError(new Error('Bitte ein ZIP-Archiv auswählen.')); return; }
                const data = new FormData(); data.append('file', file); dialog.hide();
                await run('/_action/extension/upload', 'POST', data, { rawBody: true, contentType: null }); dialog.destroy();
            } }],
        }); dialog.show();
    }
    async function permissions() {
        const row = selected(); if (!row) return;
        try {
            const app = (await api.search('app', { limit: 1, filter: [{ type: 'equals', field: 'name', value: row.name }], associations: { aclRole: {} } })).data[0];
            if (!app) throw new Error('Diese App ist nicht mehr installiert.');
            const accepted = new Set(app.aclRole?.privileges || []); const requested = new Set(app.requestedPrivileges || []);
            const privileges = [...new Set([...accepted, ...requested])].sort();
            const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, items: privileges.map((privilege, index) => ({ xtype: 'checkboxfield', name: String(index),
                boxLabel: encode(`${privilege}${requested.has(privilege) ? ' (angefordert)' : ''}`), checked: accepted.has(privilege) })) });
            const dialog = Ext.create('Ext.window.Window', { title: `App-Berechtigungen: ${row.label || row.name}`, modal: true, constrain: true, width: Math.min(680, innerWidth - 24), height: Math.min(650, innerHeight - 32), layout: 'fit', items: [form], buttons: [
                { text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Berechtigungen speichern', cls: 'emz-admin__primary', handler: async () => {
                    const values = form.getForm().getFieldValues(); const accept = privileges.filter((privilege, index) => values[String(index)] && !accepted.has(privilege)); const revoke = privileges.filter((privilege, index) => !values[String(index)] && accepted.has(privilege));
                    dialog.hide(); await run(`/app-system/${encodeURIComponent(row.name)}/privileges`, 'PATCH', { accept, revoke }); dialog.destroy();
                } },
            ] }); dialog.show();
        } catch (error) { if (api.user) showError(error); }
    }
    return grid;
}
export const extensionsModule = { id: 'extensions', title: 'Erweiterungen', entity: 'plugin', group: 'Einstellungen', access: api => api.can('system.plugin_maintain'), view: extensionView };
