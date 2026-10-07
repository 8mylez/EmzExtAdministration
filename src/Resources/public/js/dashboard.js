import { encode, money, textColumn, showError } from './ui.js';
import { rootProducts } from './products.js';

export function dashboardView(api, config, navigate) {
    const productsAllowed = api.can('product:read');
    const ordersAllowed = api.can('order:read');
    const customersAllowed = api.can('customer:read');
    const products = Ext.create('Ext.data.Store', { fields: ['id', 'name', 'productNumber', 'stock', 'active'] });
    const orders = Ext.create('Ext.data.Store', { fields: ['id', 'orderNumber', 'orderDateTime', 'amountTotal', 'currency'] });
    const panel = Ext.create('Ext.panel.Panel', {
        header: false, cls: 'emz-admin__page', bodyPadding: 16, scrollable: true, layout: 'anchor', defaults: { anchor: '100%' },
        tbar: { enableOverflow: true, items: [
            { text: 'Aktualisieren', ariaLabel: 'Aktualisieren', iconCls: 'x-fa fa-sync', handler: () => refresh() }, '->',
            { text: 'Produkte verwalten', disabled: !productsAllowed, handler: () => navigate('products') },
            { text: 'Bestellungen öffnen', disabled: !ordersAllowed, handler: () => navigate('orders') },
            { text: 'Kunden öffnen', disabled: !customersAllowed, handler: () => navigate('customers') },
        ] },
        items: [
            { xtype: 'component', html: '<h1 class="emz-admin__heading">Dein Shop im Überblick</h1><p>Aktuelle Zahlen aus deinem Shop</p>' },
            { xtype: 'component', itemId: 'metrics', ariaRole: 'status', html: '<p>Kennzahlen werden geladen …</p>' },
            ...(ordersAllowed ? [{ xtype: 'grid', title: 'Neueste Bestellungen', store: orders, height: 230,
                emptyText: 'Noch keine Bestellungen vorhanden.', viewConfig: { deferEmptyText: false },
                columns: [textColumn('Bestellnummer', 'orderNumber', { flex: 1 }),
                    { text: 'Datum', dataIndex: 'orderDateTime', width: 190, renderer: value => encode(new Date(value).toLocaleString('de-DE')) },
                    { text: 'Gesamt', dataIndex: 'amountTotal', width: 170, renderer: (value, meta, record) => record.data.currency?.isoCode ? encode(money(value, record.data.currency.isoCode)) : encode(value) }],
                listeners: { itemdblclick: () => navigate('orders') },
            }] : []),
            ...(productsAllowed ? [{ xtype: 'grid', title: 'Zuletzt bearbeitete Produkte', store: products, height: 230,
                emptyText: 'Noch keine Produkte vorhanden.', viewConfig: { deferEmptyText: false },
                columns: [textColumn('Produkt', 'name', { flex: 1 }), textColumn('Artikelnummer', 'productNumber', { width: 180 }),
                    { text: 'Bestand', dataIndex: 'stock', width: 100 },
                    { text: 'Status', dataIndex: 'active', width: 110, renderer: value => value ? 'Aktiv' : 'Inaktiv' }],
                listeners: { itemdblclick: () => navigate('products') },
            }] : []),
        ],
        listeners: { afterrender: () => refresh(), destroy: () => { products.destroy(); orders.destroy(); } },
    });
    let requestId = 0;
    async function refresh() {
        if (panel.destroyed || !api.user) return;
        const current = ++requestId;
        panel.setLoading('Dashboard wird geladen …');
        try {
            const counts = [];
            const count = (label, entity, filter = []) => counts.push({ label, request: api.search(entity, { limit: 1, filter, includes: { [entity]: ['id'] } }) });
            if (productsAllowed) {
                count('Hauptprodukte', 'product', rootProducts);
                count('Aktive Hauptprodukte', 'product', [...rootProducts, { type: 'equals', field: 'active', value: true }]);
                count('Hauptprodukte mit Bestand ≤ 5', 'product', [...rootProducts, { type: 'range', field: 'stock', parameters: { lte: 5 } }]);
            }
            if (ordersAllowed) {
                count('Bestellungen gesamt', 'order');
                const today = new Date(); today.setHours(0, 0, 0, 0);
                count('Bestellungen heute', 'order', [{ type: 'range', field: 'orderDateTime', parameters: { gte: today.toISOString() } }]);
            }
            if (customersAllowed) count('Kunden', 'customer');
            const [metrics, recentProducts, recentOrders] = await Promise.all([
                Promise.all(counts.map(async ({ label, request }) => [label, (await request).total])),
                productsAllowed ? api.search('product', { limit: 5, filter: rootProducts, sort: [{ field: 'updatedAt', order: 'DESC' }] }) : Promise.resolve({ data: [] }),
                ordersAllowed ? api.search('order', { limit: 5, sort: [{ field: 'orderDateTime', order: 'DESC' }],
                    ...(api.can('currency:read') ? { associations: { currency: {} } } : {}) }) : Promise.resolve({ data: [] }),
            ]);
            if (panel.destroyed || current !== requestId) return;
            panel.down('#metrics').update(metrics.length ? '<div class="emz-admin__metrics">' + metrics.map(([label, count]) =>
                `<div class="emz-admin__metric"><span>${encode(label)}</span><strong>${encode(count)}</strong></div>`).join('') + '</div>'
                : '<p>Für deinen Benutzer sind noch keine Kennzahlen freigegeben.</p>');
            products.loadData(recentProducts.data); orders.loadData(recentOrders.data);
        } catch (error) {
            if (!panel.destroyed && current === requestId && api.user) {
                panel.down('#metrics').update('<p>Kennzahlen konnten nicht geladen werden. Bitte erneut aktualisieren.</p>');
                showError(error);
            }
        } finally { if (!panel.destroyed && current === requestId) panel.setLoading(false); }
    }
    return panel;
}
