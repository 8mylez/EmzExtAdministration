import { entityPath, listCriteria, recordLabel, valueAt } from './entity-data.js';
import { openEntityEditor } from './entity-editor.js';
import { encode, notify, showError } from './ui.js';

export function entityListView(api, config, definition) {
    const entity = entityPath(definition.entity);
    const state = { page: 1, term: '', sort: definition.sort || 'createdAt', direction: definition.direction || 'DESC', active: 'all' };
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'raw', ...definition.columns.map(column => column.field)] });
    let requestId = 0;
    let opening = false;
    let deleting = false;
    const searchTask = new Ext.util.DelayedTask(() => { state.page = 1; refresh(); });
    const controls = [
        { xtype: 'textfield', ariaLabel: `${definition.title} suchen`, emptyText: 'Suchen …', width: 280,
            disabled: !definition.search?.length,
            listeners: { change: (field, value) => { state.term = value; searchTask.delay(300); } } },
        ...(definition.activeFilter ? [{ xtype: 'combobox', ariaLabel: 'Status filtern', width: 140,
            queryMode: 'local', editable: false, store: [['all', 'Alle Status'], ['active', 'Aktiv'], ['inactive', 'Inaktiv']], value: 'all',
            listeners: { change: (field, value) => { state.active = value; state.page = 1; refresh(); } } }] : []),
        '->', { text: 'Aktualisieren', ariaLabel: 'Aktualisieren', iconCls: 'x-fa fa-sync', handler: () => refresh() },
    ];
    const toolbar = [
        ...(definition.create === false ? [] : [{ text: `${definition.singular} anlegen`, ariaLabel: `${definition.singular} anlegen`,
            iconCls: 'x-fa fa-plus-circle', disabled: !api.can(`${definition.entity}:create`), handler: () => open() }]),
        { text: 'Öffnen', ariaLabel: 'Öffnen', iconCls: 'x-fa fa-pencil-alt', itemId: 'edit', disabled: true,
            handler: () => open(grid.getSelection()[0]?.id) },
        ...(definition.delete === false ? [] : [{ text: 'Löschen', ariaLabel: 'Löschen', iconCls: 'x-fa fa-trash', itemId: 'delete',
            disabled: true, handler: () => remove() }]),
    ];
    const grid = Ext.create('Ext.grid.Panel', {
        title: definition.title, header: false, cls: 'emz-admin__page', store, columnLines: false,
        ...(definition.multiSelect ? { selModel: { type: 'checkboxmodel', mode: 'MULTI' } } : {}),
        emptyText: 'Keine Einträge gefunden.', viewConfig: { deferEmptyText: false },
        columns: definition.columns.map(column => ({
            text: column.label, dataIndex: column.field, sortable: false,
            ...(column.width ? { width: column.width } : { flex: 1, minWidth: 120 }),
            renderer: (value, meta, row) => {
                if (column.render) return encode(column.render(value, row.get('raw')));
                if (column.type === 'boolean') return value ? 'Ja' : 'Nein';
                if (column.type === 'date') return value ? encode(new Date(value).toLocaleString('de-DE')) : '—';
                return encode(value ?? '—');
            },
        })),
        tbar: toolbar,
        dockedItems: [{ xtype: 'toolbar', dock: 'top', enableOverflow: true, items: controls }],
        bbar: [
            { text: 'Zurück', itemId: 'previous', disabled: true, handler: () => { state.page--; refresh(); } },
            { xtype: 'tbtext', itemId: 'pagination', text: 'Einträge werden geladen …' },
            { text: 'Weiter', itemId: 'next', disabled: true, handler: () => { state.page++; refresh(); } },
        ],
        listeners: {
            afterrender: () => refresh(),
            selectionchange: (selection, records) => {
                grid.down('#edit').setDisabled(records.length !== 1);
                grid.down('#delete')?.setDisabled(!records.length || !api.can(`${definition.entity}:delete`) || deleting || Boolean((definition.isDeleteLocked || definition.isLocked)?.(records[0]?.get('raw'))));
            },
            itemdblclick: (view, record) => open(record.id),
            destroy: () => { searchTask.cancel(); store.destroy(); },
        },
    });

    async function open(id) {
        if (opening || grid.destroyed) return;
        opening = true;
        try {
            await (definition.editor || openEntityEditor)(api, config, definition, id, () => { if (!grid.destroyed) refresh(); });
        } finally { opening = false; }
    }

    async function refresh() {
        if (grid.destroyed || !api.user) return;
        const current = ++requestId;
        grid.setLoading('Einträge werden geladen …');
        grid.down('#previous').disable();
        grid.down('#next').disable();
        try {
            const response = await api.search(entity, listCriteria(definition, state));
            if (grid.destroyed || current !== requestId) return;
            if (!response.data.length && state.page > 1) { state.page--; refresh(); return; }
            store.loadData(response.data.map(record => ({ ...record, raw: record, ...Object.fromEntries(definition.columns
                .filter(column => column.field.includes('.')).map(column => [column.field, valueAt(record, column.field)])) })));
            const total = response.total;
            grid.down('#pagination').setText(`Seite ${state.page} von ${Math.max(1, Math.ceil(total / 25))} · ${total} Einträge`);
            grid.down('#previous').setDisabled(state.page <= 1);
            grid.down('#next').setDisabled(state.page * 25 >= total);
        } catch (error) {
            if (!grid.destroyed && current === requestId && api.user) {
                store.removeAll();
                grid.down('#pagination').setText('Laden fehlgeschlagen. Bitte aktualisieren.');
                showError(error);
            }
        } finally { if (!grid.destroyed && current === requestId) grid.setLoading(false); }
    }

    function remove() {
        const records = grid.getSelection();
        const selected = records[0];
        if (!selected || deleting || !api.can(`${definition.entity}:delete`) || records.some(row => (definition.isDeleteLocked || definition.isLocked)?.(row.get('raw')))) return;
        Ext.Msg.confirm(`${definition.singular} löschen?`, records.length > 1 ? `${records.length} ausgewählte Einträge werden dauerhaft gelöscht.` : `„${encode(recordLabel(selected.data, definition))}“ wird dauerhaft gelöscht.`, async choice => {
            if (choice !== 'yes' || grid.destroyed || deleting) return;
            deleting = true;
            grid.down('#delete').disable();
            grid.setLoading('Eintrag wird gelöscht …');
            try {
                if (records.length > 1) await api.request('/_action/sync', 'POST', { 'delete-selected': { entity: definition.entity, action: 'delete', payload: records.map(row => ({ id: row.id })) } });
                else if (definition.write) await definition.write(api, `/${entity}/${selected.id}`, 'DELETE');
                else await api.request(`/${entity}/${selected.id}`, 'DELETE');
                notify('Eintrag gelöscht.');
                await refresh();
            } catch (error) { if (!grid.destroyed && api.user) showError(error); }
            finally {
                deleting = false;
                if (!grid.destroyed) {
                    grid.setLoading(false);
                    grid.down('#delete').setDisabled(!grid.getSelection().length || !api.can(`${definition.entity}:delete`) || Boolean((definition.isDeleteLocked || definition.isLocked)?.(grid.getSelection()[0]?.get('raw'))));
                }
            }
        });
    }
    grid.refreshRecords = refresh;
    return grid;
}
