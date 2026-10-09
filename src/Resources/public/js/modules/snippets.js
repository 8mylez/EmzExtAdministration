import { entityField } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';

export function snippetsView(api, config, fixedSet) {
    if (!fixedSet?.id) fixedSet = null;
    let page = 1; let term = ''; let filter = ''; let request = 0; let opening = false;
    const store = Ext.create('Ext.data.Store', { fields: ['translationKey', 'value', 'author', 'overridden', 'raw'] });
    const set = entityField(api, { name: 'setId', label: 'Textbaustein-Set', type: 'reference', required: true, reference: { entity: 'snippet_set' } }, fixedSet?.id, true);
    const task = new Ext.util.DelayedTask(() => { page = 1; refresh(); });
    const grid = Ext.create('Ext.grid.Panel', { title: fixedSet ? 'Textbausteine' : undefined, store,
        columns: [{ text: 'Schlüssel', dataIndex: 'translationKey', flex: 1, renderer: encode }, { text: 'Text', dataIndex: 'value', flex: 2, renderer: encode },
            { text: 'Autor', dataIndex: 'author', width: 140, renderer: encode }, { text: 'Überschrieben', dataIndex: 'overridden', width: 125, renderer: value => value ? 'Ja' : 'Nein' }],
        tbar: { enableOverflow: true, items: [{ text: 'Textbaustein anlegen', disabled: !api.can('snippet:create'), handler: () => open() },
            { text: 'Bearbeiten', itemId: 'edit', disabled: true, handler: () => open(grid.getSelection()[0]?.get('raw')) },
            { text: 'Überschreibung entfernen', itemId: 'reset', disabled: true, handler: reset }, { text: 'Aktualisieren', handler: refresh }] },
        dockedItems: [{ xtype: 'toolbar', dock: 'top', items: [set,
            { xtype: 'textfield', ariaLabel: 'Textbausteine suchen', emptyText: 'Schlüssel oder Text suchen …', width: 250, listeners: { change: (field, value) => { term = value; task.delay(300); } } },
            { xtype: 'combobox', ariaLabel: 'Textbaustein-Filter', queryMode: 'local', editable: false, value: '', width: 170,
                store: [['', 'Alle'], ['edited', 'Überschrieben'], ['added', 'Eigene Bausteine'], ['empty', 'Leere Texte']], listeners: { change: (field, value) => { filter = value; page = 1; refresh(); } } },
        ] }], bbar: [{ text: 'Zurück', itemId: 'previous', disabled: true, handler: () => { page--; refresh(); } },
            { xtype: 'tbtext', itemId: 'pagination', text: 'Bitte ein Textbaustein-Set auswählen.' }, { text: 'Weiter', itemId: 'next', disabled: true, handler: () => { page++; refresh(); } }],
        listeners: { afterrender: () => { if (fixedSet) refresh(); }, itemdblclick: (view, record) => open(record.get('raw')),
            selectionchange: () => { const row = grid.getSelection()[0]?.get('raw'); grid.down('#edit').setDisabled(!row); grid.down('#reset').setDisabled(!row?.id || !api.can('snippet:delete')); },
            destroy: () => { task.cancel(); store.destroy(); } },
    });
    set.on('change', () => { page = 1; refresh(); });
    async function refresh() {
        const current = ++request; if (grid.destroyed || !api.user) return;
        store.removeAll(); grid.down('#previous').disable(); grid.down('#next').disable();
        if (!set.getValue()) { grid.down('#pagination').setText('Bitte ein Textbaustein-Set auswählen.'); return; }
        grid.setLoading('Textbausteine werden geladen …');
        try {
            const response = await api.request('/_action/snippet-set', 'POST', { page, limit: 25, filters: { ...(term ? { term } : {}), ...(filter ? { [filter]: true } : {}) }, sort: { sortBy: 'id', sortDirection: 'ASC' } });
            if (grid.destroyed || current !== request) return;
            const rows = Object.entries(response.data).map(([key, entries]) => entries.find(entry => entry.setId === set.getValue()) || { translationKey: key, value: '', author: '', setId: set.getValue() });
            store.loadData(rows.map(row => ({ ...row, overridden: Boolean(row.id), raw: row })));
            grid.down('#pagination').setText(`Seite ${page} · ${response.total} Textbausteine`);
            grid.down('#previous').setDisabled(page <= 1); grid.down('#next').setDisabled(page * 25 >= response.total);
        } catch (error) { if (!grid.destroyed && api.user) { grid.down('#pagination').setText('Laden fehlgeschlagen.'); showError(error); } }
        finally { if (!grid.destroyed && current === request) grid.setLoading(false); }
    }
    function open(record) {
        if (opening || !set.getValue()) return; opening = true;
        const setId = record?.setId || set.getValue(); const writable = api.can(`snippet:${record?.id ? 'update' : 'create'}`); let saving = false;
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, defaults: { anchor: '100%', labelAlign: 'top' }, items: [
            { xtype: 'textfield', name: 'translationKey', fieldLabel: 'Schlüssel', allowBlank: false, value: record?.translationKey || '', readOnly: Boolean(record) || !writable },
            { xtype: 'textarea', name: 'value', fieldLabel: 'Text', height: 240, value: record?.value || '', readOnly: !writable },
            ...(record?.hasFileValue ? [{ xtype: 'textarea', fieldLabel: 'Text aus der Basisdatei', height: 130, value: record.id ? record.resetTo : record.origin, readOnly: true }] : []),
            { xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
        ] });
        const dialog = Ext.create('Ext.window.Window', { title: `Textbaustein ${record ? 'bearbeiten' : 'anlegen'}`, modal: true, width: 720, maxHeight: window.innerHeight - 32, scrollable: true, items: [form],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Speichern', cls: 'emz-admin__primary', disabled: !writable, handler: async () => {
                if (saving || !form.getForm().isValid()) return; saving = true; dialog.setLoading('Text wird gespeichert …');
                try {
                    const values = form.getForm().getValues();
                    const current = (await api.search('snippet', { limit: 1, filter: [{ type: 'equals', field: 'setId', value: setId }, { type: 'equals', field: 'translationKey', value: values.translationKey }] })).data[0];
                    if (!record && current) throw new Error('Dieser Schlüssel existiert bereits. Bitte den vorhandenen Textbaustein bearbeiten.');
                    if (current) await api.request(`/snippet/${current.id}`, 'PATCH', { value: values.value });
                    else await api.request('/snippet', 'POST', { id: uuid(), setId, translationKey: values.translationKey, value: values.value, author: record?.author || `user/${api.user.username}` });
                    dialog.destroy(); notify('Textbaustein gespeichert.'); if (!grid.destroyed) refresh();
                } catch (error) { if (!dialog.destroyed && api.user) form.down('#error').update(encode(error.message)); }
                finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
            } }], listeners: { destroy: () => { opening = false; }, beforeclose: () => {
                if (saving) return false;
                if (!form.getForm().isDirty()) return true;
                Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Änderungen gehen verloren.', choice => { if (choice === 'yes') dialog.destroy(); }); return false;
            } },
        }); form.getForm().getFields().each(field => field.resetOriginalValue()); dialog.show();
    }
    function reset() {
        const record = grid.getSelection()[0]?.get('raw'); if (!record?.id || !api.can('snippet:delete')) return;
        Ext.Msg.confirm('Überschreibung entfernen?', record.hasFileValue ? 'Der Text aus der Basisdatei wird wieder verwendet.' : 'Dieser eigene Textbaustein wird gelöscht.', async choice => {
            if (choice !== 'yes') return;
            try { await api.request(`/snippet/${record.id}`, 'DELETE'); if (!grid.destroyed) refresh(); }
            catch (error) { if (api.user) showError(error); }
        });
    }
    return grid;
}
