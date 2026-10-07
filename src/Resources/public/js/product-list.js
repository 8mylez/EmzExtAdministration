import { productCriteria, defaultPrice } from './products.js';
import { openProductEditor } from './product-editor.js';
import { encode, money, textColumn, showError } from './ui.js';
import { duplicateProduct, openProductBulk } from './product-bulk.js';

export function productListView(api, config) {
    const state = { page: 1, term: '', status: 'all', sort: 'updatedAt', direction: 'DESC' };
    let total = 0;
    let requestId = 0;
    let opening = false;
    let deleting = false;
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'name', 'productNumber', 'stock', 'active', 'price'] });
    const searchTask = new Ext.util.DelayedTask(() => { state.page = 1; refresh(); });
    const grid = Ext.create('Ext.grid.Panel', {
        header: false, cls: 'emz-admin__page', store, columnLines: false, selModel: { type: 'checkboxmodel', mode: 'MULTI' },
        emptyText: 'Keine Produkte gefunden. Suche anpassen oder ein Produkt anlegen.',
        viewConfig: { deferEmptyText: false },
        columns: { defaults: { sortable: false }, items: [
            textColumn('Produkt', 'name', { flex: 1, minWidth: 220 }),
            textColumn('Artikelnummer', 'productNumber', { width: 180 }),
            { text: 'Status', dataIndex: 'active', width: 110, renderer: value => value ? 'Aktiv' : 'Inaktiv' },
            { text: 'Bestand', dataIndex: 'stock', width: 110, align: 'right' },
            { text: `Brutto (${config.currencyCode})`, dataIndex: 'price', width: 160, align: 'right',
                renderer: (value, meta, record) => {
                    const price = value?.find(item => item.currencyId === config.currencyId);
                    return price ? money(defaultPrice(record.data, config.currencyId).gross, config.currencyCode) : '—';
                } },
        ] },
        tbar: { enableOverflow: true, items: [
            { text: 'Produkt anlegen', ariaLabel: 'Produkt anlegen', iconCls: 'x-fa fa-plus-circle', disabled: !api.can('product:create') || !api.can('tax:read'), handler: () => open() },
            { text: 'Öffnen', ariaLabel: 'Öffnen', iconCls: 'x-fa fa-pencil-alt', itemId: 'edit', disabled: true, handler: () => open(grid.getSelection()[0]?.id) },
            { text: 'Löschen', ariaLabel: 'Löschen', iconCls: 'x-fa fa-trash', itemId: 'delete', disabled: true, handler: remove },
            { text: 'Duplizieren', itemId: 'duplicate', disabled: true, handler: async () => {
                const id = grid.getSelection()[0]?.id; if (!id) return;
                try { await duplicateProduct(api, config, id, () => refresh()); } catch (error) { if (api.user) showError(error); }
            } },
            { text: 'Gemeinsam bearbeiten', itemId: 'bulk', disabled: true, handler: () => openProductBulk(api, config, grid.getSelection().map(row => row.id), refresh) },
            { text: 'Alle Treffer bearbeiten', itemId: 'bulkAll', disabled: true, handler: editAll },
            { text: 'Aktualisieren', ariaLabel: 'Aktualisieren', iconCls: 'x-fa fa-sync', handler: () => refresh() },
        ] },
        dockedItems: [{ xtype: 'toolbar', dock: 'top', enableOverflow: true, items: [
            { xtype: 'textfield', emptyText: 'Name oder Artikelnummer suchen …', ariaLabel: 'Produkte suchen', width: 310,
                listeners: { change: (field, value) => { state.term = value; searchTask.delay(350); } } },
            { xtype: 'combobox', ariaLabel: 'Produktstatus filtern', width: 160, editable: false, queryMode: 'local',
                store: [['all', 'Alle Status'], ['active', 'Aktiv'], ['inactive', 'Inaktiv']], value: 'all',
                listeners: { change: (field, value) => { state.status = value; state.page = 1; refresh(); } } },
            { xtype: 'combobox', ariaLabel: 'Sortierung', width: 220, editable: false, queryMode: 'local',
                store: [['updatedAt', 'Zuletzt bearbeitet'], ['name', 'Name A–Z'], ['productNumber', 'Artikelnummer A–Z']], value: 'updatedAt',
                listeners: { change: (field, value) => { state.sort = value; state.direction = value === 'updatedAt' ? 'DESC' : 'ASC'; state.page = 1; refresh(); } } },
        ] }],
        bbar: [
            { text: 'Zurück', itemId: 'previous', disabled: true, handler: () => { state.page--; refresh(); } },
            { xtype: 'tbtext', itemId: 'pagination', text: 'Produkte werden geladen …' },
            { text: 'Weiter', itemId: 'next', disabled: true, handler: () => { state.page++; refresh(); } },
            '->', { xtype: 'tbtext', text: 'Hauptprodukte · Systemsprache' },
        ],
        listeners: {
            afterrender: () => refresh(),
            selectionchange: (model, records) => {
                grid.down('#edit').setDisabled(records.length !== 1);
                grid.down('#duplicate').setDisabled(records.length !== 1 || !api.can('product:create'));
                grid.down('#bulk').setDisabled(!records.length || !api.can('product:update'));
                grid.down('#delete').setDisabled(!records.length || !api.can('product:delete') || deleting);
            },
            itemdblclick: (view, record) => open(record.id),
            destroy: () => { searchTask.cancel(); store.destroy(); },
        },
    });

    async function open(id) {
        if (opening) return;
        opening = true;
        try {
            await openProductEditor(api, config, id, () => { if (!grid.destroyed) refresh(); });
        } finally {
            opening = false;
        }
    }

    async function editAll() {
        if (!api.can('product:update')) return;
        grid.setLoading('Alle passenden Produkte werden ausgewählt …'); grid.down('#bulkAll').disable();
        const criteria = productCriteria(state); const ids = new Set();
        try {
            for (let page = 1; ; page++) {
                const result = await api.request('/search-ids/product', 'POST', { ...criteria, page, limit: 500, sort: [{ field: 'id', order: 'ASC' }] });
                result.data.forEach(id => ids.add(id));
                if (page * 500 >= result.total) break;
            }
            if (!grid.destroyed && ids.size) openProductBulk(api, config, [...ids], refresh);
        } catch (error) { if (api.user && !grid.destroyed) showError(error); }
        finally { if (!grid.destroyed) { grid.setLoading(false); grid.down('#bulkAll').setDisabled(!total || !api.can('product:update')); } }
    }

    function remove() {
        const records = grid.getSelection();
        const record = records[0];
        if (!record || deleting || !api.can('product:delete')) return;
        Ext.Msg.confirm('Produkt löschen?', `${records.length > 1 ? `${records.length} ausgewählte Produkte werden` : `„${encode(record.get('name'))}“ wird`} einschließlich der Varianten dauerhaft gelöscht.`, async choice => {
            if (choice !== 'yes' || grid.destroyed || deleting) return;
            deleting = true;
            grid.down('#delete').disable();
            grid.setLoading('Produkt wird gelöscht …');
            try {
                if (records.length === 1) await api.request(`/product/${record.id}`, 'DELETE');
                else await api.request('/_action/sync', 'POST', { 'delete-products': { entity: 'product', action: 'delete', payload: records.map(row => ({ id: row.id })) } });
                if (!grid.destroyed) await refresh();
            }
            catch (error) { if (!grid.destroyed && api.user) showError(error); }
            finally {
                deleting = false;
                if (!grid.destroyed) { grid.setLoading(false); grid.down('#delete').setDisabled(!grid.getSelection().length); }
            }
        });
    }

    async function refresh() {
        if (grid.destroyed || !api.user) return;
        const current = ++requestId;
        grid.setLoading('Produkte werden geladen …');
        grid.down('#previous').disable();
        grid.down('#next').disable();
        try {
            const response = await api.search('product', productCriteria(state));
            if (grid.destroyed || current !== requestId) return;
            total = response.total;
            grid.down('#bulkAll').setDisabled(!total || !api.can('product:update'));
            if (!response.data.length && state.page > 1) { state.page--; await refresh(); return; }
            store.loadData(response.data);
            grid.down('#pagination').setText(`Seite ${state.page} von ${Math.max(1, Math.ceil(total / 25))} · ${total} Produkte`);
        } catch (error) {
            if (!grid.destroyed && current === requestId) {
                store.removeAll();
                total = 0;
                grid.down('#pagination').setText('Laden fehlgeschlagen. Bitte aktualisieren.');
                showError(error);
            }
        } finally {
            if (!grid.destroyed && current === requestId) {
                grid.setLoading(false);
                grid.down('#previous').setDisabled(state.page <= 1);
                grid.down('#next').setDisabled(state.page * 25 >= total);
            }
        }
    }
    return grid;
}
