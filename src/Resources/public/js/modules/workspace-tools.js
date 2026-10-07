import { encode, showError } from '../ui.js';
import { recordLabel } from '../entity-data.js';
import { openEntityEditor } from '../entity-editor.js';
import { openProductEditor } from '../product-editor.js';

export function adminSearchView(api, config, definitions, navigate) {
    const supported = ['products', 'orders', 'customers', 'categories', 'manufacturers', 'media', 'cms', 'landing-pages', 'product-streams', 'promotions'];
    const scopes = definitions.filter(module => supported.includes(module.id) && api.can(`${module.entity}:read`));
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'entityId', 'moduleId', 'area', 'label', 'detail'] });
    let requestId = 0;
    const task = new Ext.util.DelayedTask(search);
    const panel = Ext.create('Ext.grid.Panel', { store, emptyText: 'Mindestens zwei Zeichen eingeben.', viewConfig: { deferEmptyText: false },
        columns: [{ text: 'Bereich', dataIndex: 'area', width: 180, renderer: encode }, { text: 'Treffer', dataIndex: 'label', flex: 1, renderer: encode }, { text: 'Nummer / E-Mail', dataIndex: 'detail', width: 230, renderer: encode }],
        tbar: [{ xtype: 'textfield', itemId: 'query', ariaLabel: 'Administration durchsuchen', emptyText: 'Produkte, Bestellungen, Kunden und Inhalte suchen …', flex: 1,
            listeners: { change: () => task.delay(300) } }, { text: 'Öffnen', itemId: 'open', disabled: true, handler: open }],
        bbar: [{ xtype: 'tbtext', itemId: 'count', text: 'Bis zu 10 Treffer je Bereich. Weitere Treffer findest du in der jeweiligen Liste.' }],
        listeners: { selectionchange: (model, rows) => panel.down('#open').setDisabled(!rows.length), itemdblclick: open, destroy: () => { task.cancel(); store.destroy(); } },
    });
    async function search() {
        const current = ++requestId; const term = panel.down('#query').getValue().trim();
        if (term.length < 2) { store.removeAll(); panel.setLoading(false); return; }
        panel.setLoading('Administration wird durchsucht …');
        try {
            const result = await api.request('/_admin/search', 'POST', Object.fromEntries(scopes.map(module => [module.entity, { term, limit: 10, 'total-count-mode': 1 }])));
            if (panel.destroyed || current !== requestId) return;
            const rows = []; let total = 0;
            for (const module of scopes) {
                const group = result.data[module.entity]; if (!group?.data) continue;
                total += group.total || 0;
                for (const record of Object.values(group.data)) rows.push({ id: `${module.entity}:${record.id}`, entityId: record.id, moduleId: module.id,
                    area: module.title, label: recordLabel(record, module.entity === 'customer' ? { labelFields: ['firstName', 'lastName'] } : module), detail: record.productNumber || record.orderNumber || record.email || '' });
            }
            store.loadData(rows); panel.down('#count').setText(`${rows.length} von ${total} Treffern · höchstens 10 je Bereich`);
        } catch (error) { if (!panel.destroyed && api.user && current === requestId) showError(error); }
        finally { if (!panel.destroyed && current === requestId) panel.setLoading(false); }
    }
    async function open() {
        const row = panel.getSelection()[0]; if (!row) return;
        const module = scopes.find(module => module.id === row.get('moduleId'));
        if (module.id === 'products') await openProductEditor(api, config, row.get('entityId'), search);
        else if (module.fields) await (module.editor || openEntityEditor)(api, config, module, row.get('entityId'), search);
        else navigate(module.id);
    }
    return panel;
}

function notificationsView(api) {
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'message', 'status', 'createdAt', 'read'] });
    const key = `emz.ext-admin.notifications:${api.baseUrl}:${api.user.id}`;
    let seen = api.storage.getItem(key) || '';
    let cursor = null;
    let loading = false;
    let timer;
    const panel = Ext.create('Ext.grid.Panel', { store, emptyText: 'Keine Benachrichtigungen.', viewConfig: { deferEmptyText: false },
        columns: [{ text: 'Zeitpunkt', dataIndex: 'createdAt', width: 180, renderer: value => value ? encode(new Date(value).toLocaleString('de-DE')) : '' },
            { text: 'Status', dataIndex: 'status', width: 110, renderer: encode }, { text: 'Nachricht', dataIndex: 'message', flex: 1, renderer: encode },
            { text: 'Gelesen', dataIndex: 'read', width: 80, renderer: value => value ? 'Ja' : 'Nein' }],
        tbar: [{ text: 'Aktualisieren / weitere laden', handler: load }, { text: 'Alle als gelesen markieren', handler: () => {
            seen = new Date().toISOString(); api.storage.setItem(key, seen); store.each(row => row.set('read', true));
            panel.down('#count').setText(`${store.getCount()} Nachrichten · 0 ungelesen`);
        } }],
        bbar: [{ xtype: 'tbtext', itemId: 'count', text: 'Benachrichtigungen werden geladen …' }],
        listeners: { afterrender: () => { load(); timer = setInterval(load, 20000); }, destroy: () => { clearInterval(timer); store.destroy(); } },
    });
    async function load() {
        if (loading || panel.destroyed || !api.user) return;
        loading = true;
        try {
            const result = await api.request(`/notification/message?limit=25${cursor ? `&latestTimestamp=${encodeURIComponent(cursor)}` : ''}`);
            if (panel.destroyed) return;
            const records = Object.values(result.notifications || {});
            for (const row of records) if (!store.getById(row.id)) store.insert(0, { ...row, read: Boolean(seen && new Date(row.createdAt) <= new Date(seen)) });
            if (result.timestamp) cursor = result.timestamp;
            if (store.getCount() > 500) store.removeAt(500, store.getCount() - 500);
            panel.down('#count').setText(`${store.getCount()} Nachrichten · ${store.getRange().filter(row => !row.get('read')).length} ungelesen`);
        } catch (error) { if (!panel.destroyed && api.user) panel.down('#count').setText(encode(error.message)); }
        finally { loading = false; }
    }
    return panel;
}
export const notificationsModule = { id: 'notifications', title: 'Benachrichtigungen', entity: 'notification', access: api => Boolean(api.user), view: notificationsView };
