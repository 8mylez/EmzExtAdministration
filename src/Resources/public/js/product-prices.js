import { entityField } from './entity-fields.js';
import { entityListView } from './entity-list.js';
import { openEntityEditor } from './entity-editor.js';
import { cleanPrice, replaceCurrencyPrice, validatePriceTier } from './price-data.js';
import { encode, notify, showError } from './ui.js';
import { inheritedProductChildren } from './product-associations.js';

export function currencyPricesPanel(api, config, entity, id, taxRate, title = 'Währungspreise', priceField = 'price', minimumPrice = 0) {
    const path = entity.replaceAll('_', '-');
    const canWrite = api.can(`${entity}:update`);
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'currency', 'gross', 'net', 'list', 'regulation', 'price'] });
    let record;
    let currencies = [];
    let generation = 0;
    const grid = Ext.create('Ext.grid.Panel', { title, store, emptyText: entity === 'product' ? 'Keine eigenen Preise hinterlegt. Varianten erben den Preis des Hauptprodukts.' : 'Keine Preise hinterlegt.',
        viewConfig: { deferEmptyText: false }, columns: [
            { text: 'Währung', dataIndex: 'currency', flex: 1, renderer: encode },
            ...[['gross', 'Brutto'], ['net', 'Netto'], ['list', 'Streichpreis'], ['regulation', 'Niedrigster Preis']].map(([dataIndex, text]) =>
                ({ text, dataIndex, flex: 1, renderer: value => value === null || value === undefined ? '—' : encode(Number(value).toLocaleString('de-DE', { maximumFractionDigits: 8 })) })),
        ], tbar: [
            { text: 'Währungspreis anlegen', disabled: !canWrite, handler: () => edit() },
            { text: 'Preis bearbeiten', itemId: 'editPrice', disabled: true, handler: () => edit(grid.getSelection()[0]?.id) },
            { text: 'Preis entfernen', itemId: 'removePrice', disabled: true, handler: remove },
            '->', { text: 'Aktualisieren', handler: refresh },
        ], listeners: { afterrender: refresh, itemdblclick: (view, row) => edit(row.id), destroy: () => store.destroy(),
            selectionchange: (model, rows) => {
                grid.down('#editPrice').setDisabled(!rows.length);
                grid.down('#removePrice').setDisabled(!canWrite || !rows.length || rows[0].id === config.currencyId);
            } },
    });
    if (entity === 'product') grid.addDocked({ xtype: 'toolbar', dock: 'bottom', items: [{ text: 'Preise vom Hauptprodukt erben', itemId: 'inherit', hidden: true,
        disabled: !canWrite, handler: () => Ext.Msg.confirm('Preise vererben?', 'Alle eigenen Währungspreise dieser Variante werden entfernt.', async choice => {
            if (choice !== 'yes') return;
            try { await api.request(`/product/${id}`, 'PATCH', { [priceField]: null }); refresh(); notify('Preisvererbung aktiviert.'); }
            catch (error) { if (api.user) showError(error); }
        }) }] });
    async function refresh() {
        const current = ++generation;
        if (grid.destroyed || !api.user) return;
        grid.setLoading('Preise werden geladen …');
        try {
            const [records, currencyResponse] = await Promise.all([api.search(path, { ids: [id], limit: 1 }), api.search('currency', { limit: 500 })]);
            if (grid.destroyed || current !== generation) return;
            record = records.data[0]; currencies = currencyResponse.data;
            if (!record) throw new Error('Der Datensatz ist nicht mehr vorhanden.');
            store.loadData((record[priceField] || []).map(price => ({ id: price.currencyId, price,
                currency: currencies.find(currency => currency.id === price.currencyId)?.isoCode || price.currencyId,
                gross: price.gross, net: price.net, list: price.listPrice?.gross, regulation: price.regulationPrice?.gross })));
            grid.down('#inherit')?.setHidden(!record.parentId);
        } catch (error) { if (!grid.destroyed && api.user) showError(error); }
        finally { if (!grid.destroyed && current === generation) grid.setLoading(false); }
    }
    async function edit(currencyId) {
        if (!record) return;
        try {
            const response = await api.search(path, { ids: [id], limit: 1 }, { headers: { 'sw-inheritance': '1' } });
            const effective = response.data[0];
            const price = effective?.[priceField]?.find(item => item.currencyId === currencyId);
            openPriceDialog(api, { currencyId, price, currencies, taxRate, canWrite, minimumPrice, onSave: async updated => {
                const current = (await api.search(path, { ids: [id], limit: 1 }, { headers: { 'sw-inheritance': '1' } })).data[0];
                if (!current) throw new Error('Der Datensatz ist nicht mehr vorhanden.');
                if (!currencyId && current[priceField]?.some(item => item.currencyId === updated.currencyId)) throw new Error('Für diese Währung existiert bereits ein Preis. Bitte den vorhandenen Preis bearbeiten.');
                const prices = replaceCurrencyPrice(current[priceField], updated);
                if (!prices.some(item => item.currencyId === config.currencyId)) throw new Error('Bitte zuerst einen Preis in der Systemwährung anlegen.');
                await api.request(`/${path}/${id}`, 'PATCH', { [priceField]: prices }); refresh();
            } });
        } catch (error) { if (api.user) showError(error); }
    }
    function remove() {
        const selected = grid.getSelection()[0];
        if (!selected || selected.id === config.currencyId || !canWrite) return;
        Ext.Msg.confirm('Währungspreis entfernen?', 'Für diese Währung wird anschließend wieder automatisch umgerechnet.', async choice => {
            if (choice !== 'yes') return;
            try {
                const current = (await api.search(path, { ids: [id], limit: 1 })).data[0];
                await api.request(`/${path}/${id}`, 'PATCH', { [priceField]: current[priceField].filter(price => price.currencyId !== selected.id).map(cleanPrice) }); refresh();
            } catch (error) { if (api.user) showError(error); }
        });
    }
    return grid;
}

function openPriceDialog(api, { currencyId, price, currencies, taxRate, canWrite, onSave, minimumPrice }) {
    let syncing = true;
    let saving = false;
    const numeric = (name, label, value, required = true) => ({ xtype: 'numberfield', name, fieldLabel: label, value: value ?? null,
        minValue: minimumPrice, decimalPrecision: 8, allowBlank: !required, listeners: { change: () => sync(name) } });
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true,
        defaults: { anchor: '100%', labelAlign: 'top', readOnly: !canWrite }, items: [
            entityField(api, { name: 'currencyId', label: 'Währung', required: true, readOnly: Boolean(currencyId), type: 'select',
                options: currencies.map(currency => [currency.id, `${currency.isoCode} · ${currency.name}`]) }, currencyId, canWrite),
            numeric('gross', 'Brutto', price?.gross), numeric('net', 'Netto', price?.net),
            { xtype: 'checkboxfield', name: 'linked', boxLabel: 'Brutto und Netto verknüpfen', checked: price?.linked ?? Number.isFinite(taxRate), hidden: !Number.isFinite(taxRate), listeners: { change: () => sync('gross') } },
            numeric('listGross', 'Streichpreis brutto (optional)', price?.listPrice?.gross, false), numeric('listNet', 'Streichpreis netto (optional)', price?.listPrice?.net, false),
            numeric('regulationGross', 'Niedrigster Preis brutto (optional)', price?.regulationPrice?.gross, false), numeric('regulationNet', 'Niedrigster Preis netto (optional)', price?.regulationPrice?.net, false),
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
        ] });
    const dialog = Ext.create('Ext.window.Window', { title: currencyId ? 'Währungspreis bearbeiten' : 'Währungspreis anlegen', modal: true, layout: 'fit',
        width: Math.min(540, window.innerWidth - 24), height: Math.min(720, window.innerHeight - 32), items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Preis speichern', disabled: !canWrite, cls: 'emz-admin__primary', handler: save }],
        listeners: { beforeclose: () => !saving },
    });
    syncing = false; dialog.show();
    function sync(name) {
        const basic = form.getForm();
        if (syncing || !basic.findField('linked').getValue()) return;
        const source = basic.findField(name);
        if (!source || !Number.isFinite(taxRate)) return;
        const target = name.endsWith('Gross') ? name.replace('Gross', 'Net') : name.endsWith('Net') ? name.replace('Net', 'Gross') : name === 'gross' ? 'net' : 'gross';
        const gross = name.toLowerCase().endsWith('gross');
        syncing = true;
        const value = source.getValue();
        basic.findField(target).setValue(value === null ? null : Math.round((gross ? value / (1 + taxRate / 100) : value * (1 + taxRate / 100)) * 1e8) / 1e8);
        syncing = false;
    }
    async function save() {
        if (saving || !form.getForm().isValid()) return;
        saving = true; dialog.setLoading('Preis wird gespeichert …');
        try {
            const values = form.getForm().getFieldValues();
            const payload = { currencyId: values.currencyId, gross: values.gross, net: values.net, linked: values.linked };
            for (const key of ['list', 'regulation']) {
                const gross = values[`${key}Gross`]; const net = values[`${key}Net`];
                if ((gross === null) !== (net === null)) throw new Error('Optionale Preise bitte mit Brutto und Netto ausfüllen oder beide Felder leeren.');
                if (gross !== null) payload[`${key}Price`] = { gross, net, linked: values.linked };
            }
            await onSave(payload); dialog.destroy(); notify('Preis gespeichert.');
        } catch (error) { if (!dialog.destroyed && api.user) form.down('#error').update(encode(error.message)); }
        finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}

export function advancedPricesPanel(api, config, productId, taxRate, product = { id: productId }) {
    const definition = { title: 'Erweiterte Preise', singular: 'Preisstaffel', entity: 'product_price', sort: 'quantityStart', direction: 'ASC',
        filter: [{ type: 'equals', field: 'productId', value: productId }], defaults: { productId }, associations: { rule: {} }, search: [],
        columns: [{ field: 'rule.name', label: 'Regel' }, { field: 'quantityStart', label: 'Ab Menge', width: 110 },
            { field: 'quantityEnd', label: 'Bis Menge', width: 110 }, { field: 'price', label: `Brutto (${config.currencyCode})`, render: prices => prices?.find(price => price.currencyId === config.currencyId)?.gross ?? '—' }],
        fields: [
            { name: 'ruleId', label: 'Regel', type: 'reference', required: true, reference: { entity: 'rule' } },
            { name: 'quantityStart', label: 'Ab Menge', type: 'integer', required: true, min: 1, default: 1 },
            { name: 'quantityEnd', label: 'Bis Menge (leer = unbegrenzt)', type: 'integer', min: 1 },
            { name: 'gross', label: `Brutto (${config.currencyCode})`, type: 'number', required: true, min: 0, initialValue: record => record.price?.find(price => price.currencyId === config.currencyId)?.gross },
            { name: 'net', label: `Netto (${config.currencyCode})`, type: 'number', required: true, min: 0, initialValue: record => record.price?.find(price => price.currencyId === config.currencyId)?.net },
            { name: 'linked', label: 'Brutto und Netto verknüpft', type: 'boolean', default: true, initialValue: record => record.price?.find(price => price.currencyId === config.currencyId)?.linked },
        ],
        prepare: async (payload, original, { values }) => {
            const tiers = [];
            for (let page = 1; ; page++) {
                const response = await api.search('product-price', { page, limit: 100, filter: definition.filter });
                tiers.push(...response.data); if (response.data.length < 100) break;
            }
            validatePriceTier(values, tiers, original?.id);
            if (!original || ['gross', 'net', 'linked'].some(key => key in payload)) {
                const current = original ? (await api.search('product-price', { ids: [original.id], limit: 1 })).data[0] : null;
                const old = current?.price?.find(price => price.currencyId === config.currencyId);
                const net = values.linked ? Math.round(values.gross / (1 + taxRate / 100) * 1e8) / 1e8 : values.net;
                payload.price = replaceCurrencyPrice(current?.price, { ...old, currencyId: config.currencyId, gross: values.gross, net, linked: values.linked });
            }
            delete payload.gross; delete payload.net; delete payload.linked;
            return payload;
        },
        detailTabs: (api, config, record) => [currencyPricesPanel(api, config, 'product_price', record.id, taxRate)],
        editor: openEntityEditor,
    };
    const panel = entityListView(api, config, definition); panel.setTitle(definition.title); return inheritedProductChildren(api, product, panel, definition);
}
