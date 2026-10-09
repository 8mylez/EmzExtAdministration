import { entityListView } from '../entity-list.js';
import { openEntityEditor } from '../entity-editor.js';
import { entityField } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';

const standardEntities = ['product', 'customer', 'category', 'order', 'media', 'newsletter_recipient', 'property_group_option', 'product_configurator_setting', 'product_cross_selling', 'promotion_discount', 'promotion_individual_code', 'product_price'];
const states = { progress: 'In Bearbeitung', merging_files: 'Dateien zusammenführen', succeeded: 'Abgeschlossen', failed: 'Fehlgeschlagen', aborted: 'Abgebrochen' };
const activities = { export: 'Export', import: 'Import', dryrun: 'Probelauf', invalid_records_export: 'Fehlerdatei', template: 'Vorlage' };
const pending = log => ['progress', 'merging_files'].includes(log.state);

async function download(api, fileId, name, accessToken) {
    const token = accessToken || (await api.request(`/_action/import-export/file/prepare-download/${fileId}`, 'POST', {})).accessToken;
    const blob = await api.request(`/_action/import-export/file/download?fileId=${encodeURIComponent(fileId)}&accessToken=${encodeURIComponent(token)}`, 'GET', undefined, { responseType: 'blob' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = name || 'export.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function mappingPanel(api, profile) {
    let dirty = false; let saving = false;
    const canWrite = !profile.systemDefault && api.can('import_export_profile:update');
    const store = Ext.create('Ext.data.Store', { fields: ['key', 'mappedKey', 'requiredByUser', 'useDefaultValue', 'defaultValue', 'raw'],
        data: (profile.mapping || []).map(row => ({ ...row, raw: row })) });
    const editor = { xtype: 'textfield', allowBlank: false };
    const panel = Ext.create('Ext.grid.Panel', { title: 'Feldzuordnung', store, scrollable: true,
        plugins: canWrite ? [{ ptype: 'cellediting', clicksToEdit: 1 }] : [],
        columns: [{ text: 'Datenbankfeld', dataIndex: 'key', flex: 1, editor, renderer: encode },
            { text: 'CSV-Spalte', dataIndex: 'mappedKey', flex: 1, editor, renderer: encode },
            { xtype: 'checkcolumn', text: 'Pflichtfeld', dataIndex: 'requiredByUser', disabled: !canWrite, listeners: { checkchange: () => { dirty = true; } } },
            { xtype: 'checkcolumn', text: 'Standardwert', dataIndex: 'useDefaultValue', disabled: !canWrite, listeners: { checkchange: () => { dirty = true; } } },
            { text: 'Wert', dataIndex: 'defaultValue', flex: 1, editor: 'textfield', renderer: encode }],
        tbar: [{ text: 'Zuordnung hinzufügen', disabled: !canWrite, handler: () => { store.add({ key: '', mappedKey: '', raw: {} }); dirty = true; } },
            { text: 'Zuordnung entfernen', disabled: !canWrite, handler: () => { store.remove(panel.getSelection()); dirty = true; } },
            { text: 'Aus CSV übernehmen', disabled: !canWrite, handler: () => fromTemplate() },
            '->', { text: 'Zuordnung speichern', disabled: !canWrite, handler: () => save() }],
        listeners: { edit: () => { dirty = true; }, destroy: () => store.destroy() },
    });
    panel.hasUnsavedChanges = () => dirty || saving;
    async function save() {
        panel.findPlugin('cellediting')?.completeEdit();
        if (saving) return;
        const mapping = store.getRange().map((row, position) => ({ ...row.get('raw'), key: String(row.get('key') || '').trim(),
            mappedKey: String(row.get('mappedKey') || '').trim(), requiredByUser: Boolean(row.get('requiredByUser')),
            useDefaultValue: Boolean(row.get('useDefaultValue')), defaultValue: row.get('defaultValue') ?? '', position }));
        if (!mapping.length || mapping.some(row => !row.key || !row.mappedKey) || new Set(mapping.map(row => row.mappedKey)).size !== mapping.length) {
            showError(new Error('Bitte Datenbankfelder und eindeutige CSV-Spalten für alle Zuordnungen angeben.')); return;
        }
        saving = true; panel.setLoading('Zuordnung wird gespeichert …');
        try { await api.request(`/import-export-profile/${profile.id}`, 'PATCH', { mapping }); dirty = false; notify('Feldzuordnung gespeichert.'); }
        catch (error) { if (api.user) showError(error); }
        finally { saving = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    function fromTemplate() {
        const field = Ext.create('Ext.form.field.File', { fieldLabel: 'CSV-Vorlage', buttonText: 'Datei wählen', allowBlank: false });
        const dialog = Ext.create('Ext.window.Window', { title: 'Feldzuordnung aus CSV', modal: true, width: 560, bodyPadding: 20, items: [field],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Zuordnung übernehmen', cls: 'emz-admin__primary', handler: async () => {
                const file = field.fileInputEl.dom.files[0]; if (!file) return;
                dialog.setLoading('Spalten werden gelesen …');
                try {
                    const body = new FormData(); body.append('file', file); body.append('sourceEntity', profile.sourceEntity);
                    body.append('delimiter', profile.delimiter); body.append('enclosure', profile.enclosure);
                    const mapping = await api.request('/_action/import-export/mapping-from-template', 'POST', body, { rawBody: true, contentType: null });
                    if (!panel.destroyed) { store.loadData(mapping.map(row => ({ ...row, raw: row }))); dirty = true; }
                    dialog.destroy();
                } catch (error) { if (api.user) showError(error); }
                finally { if (!dialog.destroyed) dialog.setLoading(false); }
            } }],
        }); dialog.show();
    }
    return panel;
}

function profilesDefinition(api, config, onCopied) {
    const definition = {
        title: 'Import-/Exportprofile', singular: 'Profil', entity: 'import_export_profile', sort: 'technicalName', direction: 'ASC', search: ['technicalName', 'label'],
        isLocked: record => record?.systemDefault,
        defaults: { systemDefault: false, mapping: [{ key: 'id', mappedKey: 'id', position: 0 }], updateBy: [] },
        columns: [{ field: 'label', label: 'Name' }, { field: 'sourceEntity', label: 'Objekt' }, { field: 'type', label: 'Verwendung' }, { field: 'systemDefault', label: 'Standardprofil', type: 'boolean', width: 130 }],
        fields: [{ name: 'label', label: 'Name', required: true }, { name: 'technicalName', label: 'Technischer Name', required: true },
            { name: 'type', label: 'Verwendung', type: 'select', default: 'import-export', required: true, options: [['import-export', 'Import und Export'], ['import', 'Import'], ['export', 'Export']] },
            { name: 'sourceEntity', label: 'Objekt', type: 'select', required: true, options: [], createOnly: true },
            { name: 'sourceEntity', label: 'Objekt', readOnly: true, editOnly: true },
            { name: 'fileType', label: 'Dateityp', type: 'select', required: true, default: 'text/csv', options: [['text/csv', 'CSV']] },
            { name: 'delimiter', label: 'Trennzeichen', required: true, default: ';', maxLength: 1 },
            { name: 'enclosure', label: 'Textbegrenzungszeichen', required: true, default: '"', maxLength: 1 },
            { name: 'config.createEntities', label: 'Neue Datensätze anlegen', type: 'boolean', default: true },
            { name: 'config.updateEntities', label: 'Bestehende Datensätze aktualisieren', type: 'boolean', default: true },
            { name: 'updateBy', label: 'Erkennung bestehender Datensätze (entityName und mappedKey, JSON)', type: 'json' }],
        prepare: (payload, original) => {
            if ((payload.sourceEntity ?? original?.sourceEntity) === 'order' && (payload.type ?? original?.type) !== 'export') throw new Error('Bestellprofile unterstützen nur den Export.');
            for (const key of ['delimiter', 'enclosure']) if (key in payload && [...payload[key]].length !== 1) throw new Error('Trenn- und Textbegrenzungszeichen müssen jeweils genau ein Zeichen sein.');
            if ('updateBy' in payload) {
                if (!Array.isArray(payload.updateBy) || payload.updateBy.some(row => !row?.entityName || (row.mappedKey !== null && typeof row.mappedKey !== 'string'))) throw new Error('Die Erkennung benötigt eine Liste mit entityName und mappedKey.');
            }
            return payload;
        },
        editor: async (api, config, definition, id, onSaved) => {
            try {
                const features = await api.request('/_action/import-export/features');
                return openEntityEditor(api, config, { ...definition, fields: definition.fields.map(field => field.name === 'sourceEntity' && field.createOnly
                    ? { ...field, options: [...new Set([...standardEntities, ...features.entities])].map(entity => [entity, entity]) } : field) }, id, onSaved);
            } catch (error) { if (api.user) showError(error); }
        },
        detailTabs: (api, config, record) => [mappingPanel(api, record), Ext.create('Ext.panel.Panel', { title: 'Vorlage und Kopie', bodyPadding: 20, items: [
            { xtype: 'button', text: 'CSV-Vorlage herunterladen', handler: async () => {
                try {
                    const result = await api.request(`/_action/import-export/prepare-template-file-download?profileId=${record.id}`, 'POST', {});
                    await download(api, result.fileId, `${record.technicalName}.csv`, result.accessToken);
                } catch (error) { if (api.user) showError(error); }
            } },
            { xtype: 'button', text: 'Profil kopieren', disabled: !api.can('import_export_profile:create'), handler: async button => {
                button.disable();
                try {
                    const source = (await api.search('import-export-profile', { ids: [record.id], limit: 1 })).data[0];
                    const copied = Object.fromEntries(['label', 'type', 'sourceEntity', 'fileType', 'delimiter', 'enclosure', 'mapping', 'updateBy', 'config'].map(key => [key, source[key]]));
                    await api.request('/import-export-profile', 'POST', { ...copied, id: uuid(), technicalName: `${source.technicalName}_copy_${Date.now()}`, label: `${source.label} – Kopie`, systemDefault: false });
                    onCopied(); notify('Profil kopiert. Die Kopie steht in der Profilliste.');
                } catch (error) { if (api.user) showError(error); }
                finally { if (!button.destroyed) button.enable(); }
            } },
        ] })],
    }; return definition;
}

export const importExportModule = { id: 'import-export', title: 'Import / Export', entity: 'import_export_log', group: 'Einstellungen', icon: 'x-fa fa-exchange-alt',
    access: api => api.can('import_export_log:read') && api.can('import_export_profile:read'), view: importExportView };

function importExportView(api, config) {
    let page = 1; let timer; let busy = false; let refreshId = 0;
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'profileName', 'activity', 'state', 'records', 'createdAt', 'raw'] });
    const history = Ext.create('Ext.grid.Panel', { title: 'Verlauf', store, columns: [
        { text: 'Profil', dataIndex: 'profileName', flex: 1, renderer: encode },
        { text: 'Vorgang', dataIndex: 'activity', width: 120, renderer: value => encode(activities[value] || value) },
        { text: 'Status', dataIndex: 'state', width: 150, renderer: value => encode(states[value] || value) },
        { text: 'Datensätze', dataIndex: 'records', width: 100 },
        { text: 'Zeitpunkt', dataIndex: 'createdAt', width: 185, renderer: value => encode(new Date(value).toLocaleString('de-DE')) },
    ], tbar: [{ text: 'Aktualisieren', handler: () => refresh() },
        { text: 'Datei herunterladen', itemId: 'download', disabled: true, handler: () => action('download') },
        { text: 'Fehlerdatei herunterladen', itemId: 'errors', disabled: true, handler: () => action('errors') },
        { text: 'Details', itemId: 'details', disabled: true, handler: () => action('details') },
        { text: 'Vorgang abbrechen', itemId: 'cancel', disabled: true, handler: () => action('cancel') }],
        bbar: [{ text: 'Zurück', itemId: 'previous', disabled: true, handler: () => { page--; refresh(); } },
            { xtype: 'tbtext', itemId: 'pagination' }, { text: 'Weiter', itemId: 'next', disabled: true, handler: () => { page++; refresh(); } }],
        listeners: { selectionchange: updateActions, itemdblclick: () => action('details') },
    });
    const profileField = entityField(api, { name: 'profileId', label: 'Profil', required: true, type: 'reference', reference: { entity: 'import_export_profile', labelFields: ['label'] } }, null, true);
    const form = Ext.create('Ext.form.Panel', { title: 'Import / Export starten', bodyPadding: 24, scrollable: true, defaults: { anchor: '100%', labelAlign: 'top' }, items: [
        profileField,
        { xtype: 'combobox', name: 'activity', fieldLabel: 'Vorgang', editable: false, queryMode: 'local', value: 'export', store: [['export', 'Export'], ['dryrun', 'Import-Probelauf'], ['import', 'Import']],
            listeners: { change: (field, value) => { form.down('#file').setDisabled(value === 'export'); form.down('#confirm').setVisible(value === 'import'); } } },
        { xtype: 'filefield', name: 'file', itemId: 'file', fieldLabel: 'CSV-Datei', buttonText: 'Datei wählen', disabled: true },
        { xtype: 'checkboxfield', name: 'confirm', itemId: 'confirm', hidden: true, boxLabel: 'Die CSV-Datei soll gemäß Profil Datensätze anlegen oder aktualisieren.' },
        { xtype: 'component', html: '<p>Ein Probelauf prüft die Datei ohne dauerhafte Änderungen. Aufträge werden im Hintergrund verarbeitet. Ergebnisse und Fehlerdateien stehen im Verlauf zur Verfügung.</p>' },
        { xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
        { xtype: 'button', text: 'Vorgang starten', disabled: !api.can('import_export_file:create'), handler: () => start() },
    ] });
    const profiles = entityListView(api, config, profilesDefinition(api, config, () => profiles.refreshRecords())); profiles.setTitle('Profile');
    const panel = Ext.create('Ext.tab.Panel', { items: [form, history, profiles], listeners: {
        afterrender: () => refresh(), destroy: () => { clearTimeout(timer); store.destroy(); },
    } });
    function updateActions() {
        const log = history.getSelection()[0]?.get('raw');
        history.down('#download').setDisabled(!log?.fileId || pending(log));
        history.down('#errors').setDisabled(!log?.invalidRecordsLog?.fileId);
        history.down('#details').setDisabled(!log);
        history.down('#cancel').setDisabled(!log || !pending(log) || !api.can('import_export_file:update'));
    }
    async function refresh() {
        clearTimeout(timer); if (panel.destroyed || !api.user) return;
        const current = ++refreshId;
        try {
            const response = await api.search('import-export-log', { page, limit: 25, sort: [{ field: 'createdAt', order: 'DESC' }], associations: { file: {}, invalidRecordsLog: { associations: { file: {} } } } });
            if (panel.destroyed || current !== refreshId) return;
            const selected = history.getSelection()[0]?.id;
            store.loadData(response.data.map(log => ({ ...log, raw: log })));
            if (selected && store.getById(selected)) history.setSelection(store.getById(selected));
            history.down('#pagination').setText(`Seite ${page} · ${response.total} Vorgänge`);
            history.down('#previous').setDisabled(page <= 1); history.down('#next').setDisabled(page * 25 >= response.total);
            updateActions();
        } catch (error) { if (!panel.destroyed && api.user) { history.down('#pagination').setText('Laden fehlgeschlagen.'); showError(error); } }
        finally { if (!panel.destroyed && api.user && current === refreshId) timer = setTimeout(refresh, 4000); }
    }
    async function start() {
        if (busy || !form.getForm().isValid()) return;
        const values = form.getForm().getValues(); const file = form.down('#file').fileInputEl.dom.files[0];
        if (values.activity !== 'export' && !file) { form.down('#error').update('Bitte eine CSV-Datei auswählen.'); return; }
        if (values.activity === 'import' && !form.down('#confirm').getValue()) { form.down('#error').update('Bitte die Übernahme der Datensätze bestätigen.'); return; }
        busy = true; form.setLoading('Vorgang wird vorbereitet …'); form.down('#error').update('');
        let log;
        try {
            const profile = (await api.search('import-export-profile', { ids: [values.profileId], limit: 1 })).data[0];
            if (!profile) throw new Error('Das Profil wurde nicht gefunden.');
            if ((values.activity === 'export' && profile.type === 'import') || (values.activity !== 'export' && profile.type === 'export')) throw new Error('Dieses Profil unterstützt den ausgewählten Vorgang nicht.');
            const expireDate = new Date(Date.now() + 30 * 86400000).toISOString();
            let body = { profileId: values.profileId, expireDate }; let options = {};
            if (values.activity !== 'export') {
                const features = await api.request('/_action/import-export/features');
                if (features.uploadFileSizeLimit && file.size > features.uploadFileSizeLimit) throw new Error('Die Datei überschreitet das Upload-Limit des Shops.');
                body = new FormData(); body.append('profileId', values.profileId); body.append('expireDate', expireDate); body.append('file', file);
                if (values.activity === 'dryrun') body.append('dryRun', 'true');
                options = { rawBody: true, contentType: null };
            }
            log = (await api.request('/_action/import-export/prepare', 'POST', body, options)).log;
            await api.request('/_action/import-export/process', 'POST', { logId: log.id });
            if (!panel.destroyed) { page = 1; panel.setActiveTab(history); await refresh(); notify('Vorgang gestartet.'); }
        } catch (error) {
            if (log && api.user) { try { await api.request('/_action/import-export/cancel', 'POST', { logId: log.id }); } catch { /* Keep the original processing error visible. */ } }
            if (!form.destroyed && api.user) form.down('#error').update(encode(error.message));
        } finally { busy = false; if (!form.destroyed) form.setLoading(false); }
    }
    async function action(type) {
        const log = history.getSelection()[0]?.get('raw'); if (!log) return;
        if (type === 'details') {
            Ext.create('Ext.window.Window', { title: 'Import-/Exportdetails', modal: true, width: 700, height: 450, layout: 'fit', items: [
                { xtype: 'textarea', readOnly: true, ariaLabel: 'Ergebnis', value: JSON.stringify({ status: states[log.state], activity: activities[log.activity], records: log.records, result: log.result }, null, 2) },
            ] }).show(); return;
        }
        if (type === 'cancel') {
            Ext.Msg.confirm('Vorgang abbrechen?', 'Bereits verarbeitete Datensätze bleiben erhalten.', async choice => {
                if (choice !== 'yes') return;
                try { await api.request('/_action/import-export/cancel', 'POST', { logId: log.id }); await refresh(); }
                catch (error) { if (api.user) showError(error); }
            }); return;
        }
        try { const file = type === 'errors' ? log.invalidRecordsLog.file : log.file; await download(api, file.id, file.originalName); }
        catch (error) { if (api.user) showError(error); }
    }
    return panel;
}
