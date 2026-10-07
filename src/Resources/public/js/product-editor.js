import { defaultPrice, productPayload } from './products.js';
import { encode, notify, showError } from './ui.js';
import { entityField, formValues } from './entity-fields.js';
import { entityPayload } from './entity-data.js';
import { productDetailFields, productRelationTabs } from './product-details.js';
import { recordContentTabs } from './record-content.js';
import { applyProductInheritance, productInheritanceControls, resolvedProductValues } from './product-inheritance.js';

export async function openProductEditor(api, config, id, onSaved) {
    const canWrite = api.can(id ? 'product:update' : 'product:create') && api.can('tax:read');
    let product;
    let taxes;
    let own;
    let parent;
    try {
        const responses = await Promise.all([
            id ? api.search('product', { ids: [id], limit: 1 }, { headers: { 'sw-inheritance': '1' } }) : Promise.resolve({ data: [] }),
            api.can('tax:read') ? api.search('tax', { limit: 100, sort: [{ field: 'taxRate', order: 'DESC' }] }) : Promise.resolve({ data: [] }),
        ]);
        product = resolvedProductValues(responses[0].data[0]);
        taxes = responses[1].data;
        if (id && !product) throw new Error('Dieses Produkt ist nicht mehr vorhanden. Bitte die Liste aktualisieren.');
        if (product?.parentId) {
            const records = await Promise.all([api.search('product', { ids: [id], limit: 1 }),
                api.search('product', { ids: [product.parentId], limit: 1 }, { headers: { 'sw-inheritance': '1' } })]);
            own = records[0].data[0]; parent = resolvedProductValues(records[1].data[0]);
        }
    } catch (error) {
        showError(error);
        return;
    }
    if (!api.user) return;
    const price = defaultPrice(product, config.currencyId);
    let contentTabs = [];
    if (id) {
        try { contentTabs = await recordContentTabs(api, config, { entity: 'product', fields: [
            { name: 'name', label: 'Produktname', required: true }, { name: 'description', label: 'Beschreibung (HTML)', type: 'textarea' }, ...productDetailFields,
        ] }, product); }
        catch (error) { if (api.user) showError(error); }
    }
    if (!api.user) { contentTabs.forEach(tab => tab.destroy()); return; }
    let syncing = true;
    let saving = false;
    const form = Ext.create('Ext.form.Panel', {
        title: 'Allgemein', bodyPadding: 24, scrollable: true,
        defaults: { xtype: 'textfield', anchor: '100%', labelAlign: 'top', readOnly: !canWrite },
        items: [
            { xtype: 'component', html: '<p>Stammdaten und Standardpreis in der Systemsprache. Neue Produkte werden zunächst ohne Verkaufskanal-Zuordnung angelegt.</p>' },
            { name: 'name', fieldLabel: 'Produktname', allowBlank: false, maxLength: 255 },
            { name: 'productNumber', fieldLabel: 'Artikelnummer', allowBlank: false, maxLength: 64 },
            { xtype: 'checkboxfield', name: 'active', fieldLabel: 'Status', boxLabel: 'Produkt aktiv' },
            { xtype: 'numberfield', name: 'stock', fieldLabel: 'Lagerbestand', allowBlank: false, allowDecimals: false },
            { xtype: 'combobox', name: 'taxId', fieldLabel: 'Steuersatz', allowBlank: false, forceSelection: true, editable: false,
                queryMode: 'local', displayField: 'name', valueField: 'id',
                store: Ext.create('Ext.data.Store', { fields: ['id', 'name', 'taxRate'], data: taxes }),
                listConfig: { getInnerTpl: () => '{name:htmlEncode} ({taxRate} %)' },
                listeners: { change: () => syncPrice('gross') } },
            { xtype: 'numberfield', name: 'gross', fieldLabel: `Bruttopreis (${config.currencyCode})`,
                minValue: 0, allowBlank: false, decimalPrecision: 4, step: 0.01, listeners: { change: () => syncPrice('gross') } },
            { xtype: 'numberfield', name: 'net', fieldLabel: `Nettopreis (${config.currencyCode})`,
                minValue: 0, allowBlank: false, decimalPrecision: 4, step: 0.01, listeners: { change: () => syncPrice('net') } },
            { xtype: 'checkboxfield', name: 'linked', boxLabel: 'Brutto und Netto über den Steuersatz verknüpfen',
                listeners: { change: () => syncPrice('gross') } },
            { xtype: 'textareafield', name: 'description', fieldLabel: 'Beschreibung (HTML)', height: 140 },
            { xtype: 'fieldset', title: 'Weitere Produktdaten', collapsible: true, collapsed: true, toggleOnTitleClick: true,
                items: productDetailFields.map(field => entityField(api, field, product?.[field.name], canWrite && !(id && field.createOnly))) },
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
        ],
    });
    const basic = form.getForm();
    basic.setValues({ name: product?.name || '', productNumber: product?.productNumber || '', stock: product?.stock || 0,
        active: product?.active || false, description: product?.description || '',
        taxId: product?.taxId || taxes[0]?.id, gross: price.gross, net: price.net, linked: price.linked });
    form.systemCurrencyId = config.currencyId;
    const inheritance = own && parent ? productInheritanceControls(form, own, parent, productDetailFields, canWrite) : new Map();
    const relationTabs = id ? productRelationTabs(api, config, product, openProductEditor, taxes.find(tax => tax.id === product.taxId)?.taxRate) : [];
    syncing = false;
    const dialog = Ext.create('Ext.window.Window', {
        title: id ? 'Produkt bearbeiten' : 'Produkt anlegen', modal: true, layout: 'fit',
        width: Math.min(1040, window.innerWidth - 24), height: Math.min(840, window.innerHeight - 32),
        constrain: true, resizable: true, items: [{ xtype: 'tabpanel', tabPosition: 'left', tabRotation: 0, tabBar: { width: 175 }, items: [form,
            ...relationTabs, ...contentTabs] }],
        buttons: [
            { text: 'Abbrechen', handler: () => dialog.close() },
            { text: 'Speichern', ariaLabel: 'Speichern', cls: 'emz-admin__primary', iconCls: 'x-fa fa-check', disabled: !canWrite, handler: save },
        ],
        listeners: {
            beforeclose: () => {
                if (saving) return false;
                if ([...contentTabs, ...relationTabs].some(tab => tab.isSaving?.())) return false;
                if (!basic.isDirty() && ![...contentTabs, ...relationTabs].some(tab => tab.hasUnsavedChanges?.())) return true;
                Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Änderungen gehen verloren.', choice => {
                    if (choice === 'yes') dialog.destroy();
                });
                return false;
            },
        },
    });
    // Establish the loaded record as the clean baseline for the close confirmation.
    basic.getFields().each(field => field.resetOriginalValue());
    dialog.show();

    function syncPrice(source) {
        if (syncing || inheritance?.get('price')?.getValue() || !basic.findField('linked').getValue()) return;
        const tax = taxes.find(item => item.id === basic.findField('taxId').getValue());
        const value = basic.findField(source).getValue();
        if (!tax || value === null) return;
        syncing = true;
        const factor = 1 + tax.taxRate / 100;
        basic.findField(source === 'gross' ? 'net' : 'gross').setValue(
            Math.round((source === 'gross' ? value / factor : value * factor) * 10000) / 10000,
        );
        syncing = false;
    }

    async function save() {
        if (saving || !canWrite || !basic.isValid()) return;
        if ([...contentTabs, ...relationTabs].some(tab => tab.hasUnsavedChanges?.() || tab.isSaving?.())) { showError(new Error('Bitte die Änderungen in den weiteren Reitern zuerst dort speichern und laufende Vorgänge abwarten.')); return; }
        saving = true;
        dialog.setLoading('Produkt wird gespeichert …');
        try {
            const values = basic.getFieldValues();
            values.name = values.name.trim();
            values.productNumber = values.productNumber.trim();
            if (!values.name || !values.productNumber) throw new Error('Produktname und Artikelnummer dürfen nicht leer sein.');
            const changedFields = new Set();
            basic.getFields().each(field => { if (field.isDirty()) changedFields.add(field.getName()); });
            const details = formValues(form, productDetailFields);
            // Detail tabs save independently; fetch current prices before editing the base price.
            const currentProduct = id && ['gross', 'net', 'linked'].some(field => changedFields.has(field))
                ? { ...product, price: (await api.search('product', { ids: [id], limit: 1 }, { headers: { 'sw-inheritance': '1' } })).data[0]?.price }
                : product;
            const payload = { ...productPayload(values, currentProduct, config.currencyId, changedFields),
                ...entityPayload({ fields: productDetailFields }, details.values, product, details.dirty) };
            if (own) applyProductInheritance(payload, new Map([...inheritance].map(([name, field]) => [name, field.getValue()])), own,
                { ...values, ...details.values }, productDetailFields, currentProduct.price, config.currencyId);
            if (Object.keys(payload).length) await api.request(id ? `/product/${id}` : '/product', id ? 'PATCH' : 'POST', payload);
            dialog.destroy();
            notify('Produkt gespeichert.');
            onSaved();
        } catch (error) {
            if (!dialog.destroyed) form.down('#error').update(encode(error.message).replaceAll('\n', '<br>'));
        } finally {
            saving = false;
            if (!dialog.destroyed) dialog.setLoading(false);
        }
    }
}
