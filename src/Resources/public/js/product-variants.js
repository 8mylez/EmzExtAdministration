import { variantPlan } from './variant-data.js';
import { uuid } from './entity-data.js';
import { encode, notify, showError } from './ui.js';

export async function openVariantGenerator(api, config, productId, onSaved) {
    let rows;
    try {
        const [products, combinations, currencies] = await Promise.all([
            api.search('product', { ids: [productId], limit: 1 }),
            api.request(`/_action/product/${productId}/combinations`),
            api.search('currency', { limit: 500 }),
        ]);
        const product = products.data[0];
        if (!product || product.parentId) throw new Error('Varianten lassen sich nur für ein Hauptprodukt erzeugen.');
        const settings = [];
        for (let page = 1; ; page++) {
            const response = await api.search('product-configurator-setting', { page, limit: 100,
                filter: [{ type: 'equals', field: 'productId', value: productId }], associations: { option: { associations: { group: {} } } } });
            settings.push(...response.data);
            if (response.data.length < 100) break;
        }
        rows = variantPlan(product, settings, combinations, currencies.data, config.currencyId);
    } catch (error) { if (api.user) showError(error); return; }
    if (!api.user) return;
    let saving = false;
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'productNumber', 'label', 'stock', 'payload'],
        data: rows.map(({ label, ...payload }) => ({ id: uuid(), productNumber: payload.productNumber, label, stock: 0, payload })) });
    const grid = Ext.create('Ext.grid.Panel', { store, flex: 1, width: '100%',
        selModel: { type: 'checkboxmodel', mode: 'MULTI' }, plugins: { cellediting: { clicksToEdit: 1 } },
        emptyText: 'Alle zulässigen Kombinationen existieren bereits.', viewConfig: { deferEmptyText: false },
        columns: [
            { text: 'Artikelnummer', dataIndex: 'productNumber', width: 200, renderer: encode, editor: { xtype: 'textfield', allowBlank: false, maxLength: 64 } },
            { text: 'Ausprägungen', dataIndex: 'label', flex: 1, renderer: encode },
            { text: 'Bestand', dataIndex: 'stock', width: 100, editor: { xtype: 'numberfield', allowDecimals: false, allowBlank: false } },
        ], listeners: { afterrender: () => grid.getSelectionModel().selectAll() },
    });
    const dialog = Ext.create('Ext.window.Window', { title: 'Varianten erzeugen', modal: true, constrain: true,
        width: Math.min(980, window.innerWidth - 24), height: Math.min(700, window.innerHeight - 32),
        layout: { type: 'vbox', align: 'stretch' }, bodyPadding: 16,
        items: [{ xtype: 'component', html: `<p>${rows.length} neue Kombinationen. Gewünschte Zeilen auswählen; Artikelnummer und Bestand sind direkt bearbeitbar. Vorhandene Varianten bleiben erhalten. Preise werden vererbt oder aus den konfigurierten Aufschlägen berechnet.</p>` }, grid,
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' }],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Ausgewählte Varianten erzeugen', disabled: !rows.length, cls: 'emz-admin__primary', handler: save }],
        listeners: { beforeclose: () => !saving, destroy: () => store.destroy() },
    });
    dialog.show();

    async function save() {
        if (saving) return;
        grid.findPlugin('cellediting').completeEdit();
        const selection = grid.getSelection();
        if (!selection.length) return;
        saving = true;
        try {
            const payload = selection.map(record => ({ ...record.get('payload'), id: record.id,
                productNumber: record.get('productNumber').trim(), stock: record.get('stock') }));
            const numbers = payload.map(item => item.productNumber);
            if (numbers.some(number => !number || number.length > 64) || new Set(numbers).size !== numbers.length) throw new Error('Artikelnummern müssen eindeutig und zwischen 1 und 64 Zeichen lang sein.');
            if (payload.some(item => !Number.isInteger(item.stock))) throw new Error('Bitte einen ganzzahligen Bestand für jede Variante eingeben.');
            // One sync operation keeps the selected variants atomic if any number conflicts.
            dialog.setLoading(`${payload.length} Varianten werden erzeugt …`);
            await api.request('/_action/sync', 'POST', { variants: { entity: 'product', action: 'upsert', payload } });
            dialog.destroy(); onSaved(); notify(`${payload.length} Varianten erzeugt.`);
        } catch (error) { if (!dialog.destroyed && api.user) dialog.down('#error').update(encode(error.message)); }
        finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}
