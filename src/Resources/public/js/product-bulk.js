import { entityField, formValues } from './entity-fields.js';
import { entityPayload } from './entity-data.js';
import { productDetailFields } from './product-details.js';
import { replaceCurrencyPrice } from './price-data.js';
import { encode, notify } from './ui.js';
import { productAssociations, associationRecords } from './product-associations.js';

export function bulkAssociationChange(product, relation, own, inherited, mode, selected) {
    if (mode === 'inherit' && !product.parentId) throw new Error(`${product.productNumber}: Nur Varianten können Zuordnungen vom Hauptprodukt erben.`);
    const effective = own.length || !product.parentId ? own : inherited;
    const values = mode === 'add' ? [...new Set([...effective, ...selected])] : mode === 'remove' ? effective.filter(id => !selected.includes(id)) : mode === 'replace' ? selected : [];
    if (product.parentId && mode !== 'inherit' && !values.length && inherited.length) throw new Error(`${product.productNumber}: Ohne eigene ${relation.title} erbt die Variante wieder vom Hauptprodukt. Bitte mindestens eine Zuordnung wählen oder ausdrücklich die Vererbung herstellen.`);
    return { add: values.filter(id => !own.includes(id)), remove: own.filter(id => !values.includes(id)) };
}

export function bulkProductPayload(record, fields, values, selected, priceChange, currencyId, taxes) {
    const payload = { id: record.id, ...entityPayload({ fields }, values, record, selected) };
    if (!priceChange) return payload;
    const original = record.price?.find(price => price.currencyId === currencyId);
    if (priceChange.mode === 'percent' && !original) throw new Error(`${record.productNumber}: Für eine prozentuale Preisänderung fehlt der Systemwährungspreis.`);
    const tax = taxes.find(tax => tax.id === (payload.taxId || record.taxId));
    if (!tax) throw new Error(`${record.productNumber}: Der Steuersatz konnte nicht geladen werden.`);
    const gross = Math.round((priceChange.mode === 'percent' ? original.gross * (1 + priceChange.value / 100) : priceChange.value) * 100000000) / 100000000;
    const linked = priceChange.mode === 'percent' ? original.linked : true;
    const net = Math.round((linked ? gross / (1 + tax.taxRate / 100) : original.net * (1 + priceChange.value / 100)) * 100000000) / 100000000;
    payload.price = replaceCurrencyPrice(record.price, { ...original, currencyId, gross, net, linked });
    return payload;
}

export function openProductBulk(api, config, ids, onSaved) {
    let saving = false;
    let planned = null;
    let completed = 0;
    const fields = [
        { name: 'name', label: 'Produktname', required: true }, { name: 'description', label: 'Beschreibung (HTML)', type: 'textarea' },
        { name: 'stock', label: 'Bestand', type: 'integer', min: 0, required: true }, { name: 'active', label: 'Aktiv', type: 'boolean' },
        { name: 'taxId', label: 'Steuersatz', type: 'reference', reference: { entity: 'tax' }, required: true },
        ...productDetailFields.filter(field => !field.createOnly),
    ];
    const enabled = new Map();
    const items = fields.flatMap(description => {
        const control = entityField(api, description, null, true); const field = control.isComponent ? control : Ext.widget(control); field.setDisabled(true);
        const checkbox = Ext.create('Ext.form.field.Checkbox', { boxLabel: `Ändern: ${encode(description.label)}`,
            disabled: description.reference && !api.can(`${description.reference.entity}:read`), listeners: { change: (box, checked) => field.setDisabled(!checked) } });
        enabled.set(description.name, checkbox); return [checkbox, field];
    });
    const priceBox = Ext.create('Ext.form.field.Checkbox', { boxLabel: 'Systemwährungspreise ändern', disabled: !api.can('tax:read') });
    const priceMode = Ext.widget(entityField(api, { name: 'priceMode', label: 'Preisänderung', type: 'select', options: [['set', 'Bruttopreis setzen'], ['percent', 'Prozentual ändern']], required: true }, 'set', true));
    const priceValue = Ext.widget(entityField(api, { name: 'priceValue', label: `Wert (${config.currencyCode} oder Prozent)`, type: 'number', required: true, min: 0 }, null, true));
    priceMode.disable(); priceValue.disable(); priceBox.on('change', (box, checked) => { priceMode.setDisabled(!checked); priceValue.setDisabled(!checked); });
    priceMode.on('change', (field, mode) => priceValue.setMinValue(mode === 'percent' ? -100 : 0));
    const associationFields = productAssociations.filter(relation => api.can(`${relation.entity}:read`)).map(relation => {
        const options = [['keep', 'Unverändert'],
            ...(api.can(`${relation.mapping}:create`) ? [['add', 'Hinzufügen']] : []),
            ...(api.can(`${relation.mapping}:delete`) ? [['remove', 'Entfernen'], ['inherit', 'Vom Hauptprodukt erben (nur Varianten)']] : []),
            ...(['create', 'delete'].every(action => api.can(`${relation.mapping}:${action}`)) ? [['replace', 'Ersetzen']] : []),
        ];
        const mode = Ext.widget(entityField(api, { name: `association-${relation.association}`, label: `Änderung: ${relation.title}`, type: 'select', options }, 'keep', true));
        const values = entityField(api, { name: `values-${relation.association}`, label: relation.title, multiple: true, type: 'reference', reference: { entity: relation.entity } }, [], true);
        values.disable(); mode.on('change', (field, value) => values.setDisabled(['keep', 'inherit'].includes(value)));
        return { relation, mode, values };
    });
    const form = Ext.create('Ext.form.Panel', { layout: 'fit', items: [{ xtype: 'tabpanel', items: [
        { xtype: 'panel', title: 'Stammdaten', bodyPadding: 20, scrollable: true, items },
        { xtype: 'panel', title: 'Preise', bodyPadding: 20, scrollable: true, items: [priceBox, priceMode, priceValue] },
        { xtype: 'panel', title: 'Zuordnungen', bodyPadding: 20, scrollable: true, items: associationFields.flatMap(item => [item.mode, item.values]) },
    ] }], dockedItems: [
        { xtype: 'component', dock: 'top', html: `<p>${ids.length} ausgewählte Produkte. Nur markierte Felder und Zuordnungen werden geändert.</p>` },
        { xtype: 'component', dock: 'bottom', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
    ] });
    const dialog = Ext.create('Ext.window.Window', { title: 'Produkte gemeinsam bearbeiten', modal: true, constrain: true, layout: 'fit', width: Math.min(760, innerWidth - 24), height: Math.min(820, innerHeight - 32), items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Änderungen anwenden', cls: 'emz-admin__primary', handler: save }], listeners: { beforeclose: () => !saving },
    }); dialog.show();
    async function save() {
        if (saving || !api.can('product:update') || !form.getForm().isValid()) return;
        const selected = new Set([...enabled].filter(([, checkbox]) => checkbox.getValue()).map(([name]) => name));
        const associations = associationFields.filter(item => item.mode.getValue() !== 'keep');
        if (!selected.size && !priceBox.getValue() && !associations.length) { form.down('#error').update('Bitte mindestens ein Feld zum Ändern markieren.'); return; }
        const changes = [...selected].map(name => fields.find(field => field.name === name).label).concat(priceBox.getValue() ? ['Systemwährungspreis'] : [], associations.map(item => item.relation.title));
        Ext.Msg.confirm('Massenänderung anwenden?', `${ids.length} Produkte erhalten neue Werte für: ${encode(changes.join(', '))}.`, async choice => {
            if (choice !== 'yes' || saving || dialog.destroyed) return;
            saving = true; dialog.setLoading('Änderungen werden geprüft …');
            try {
                if (!planned) {
                const { values } = formValues(form, fields.filter(field => selected.has(field.name)));
                const records = [];
                for (let index = 0; index < ids.length; index += 100) {
                    const result = await api.search('product', { ids: ids.slice(index, index + 100), limit: 100 }, { headers: { 'sw-inheritance': '1' } }); records.push(...result.data);
                }
                if (records.length !== ids.length) throw new Error('Ein Produkt ist nicht mehr vorhanden. Bitte die Auswahl aktualisieren.');
                const price = priceBox.getValue() ? { mode: priceMode.getValue(), value: priceValue.getValue() } : null;
                const taxIds = [...new Set(records.map(record => selected.has('taxId') ? values.taxId : record.taxId))];
                const taxes = price ? (await api.search('tax', { ids: taxIds, limit: Math.min(500, taxIds.length) })).data : [];
                const associationsByProduct = new Map();
                for (const item of associations) {
                    const relation = item.relation;
                    for (let index = 0; index < ids.length; index += 100) {
                        const raw = await api.search('product', { ids: ids.slice(index, index + 100), limit: 100, associations: { [relation.association]: { limit: 100 } } });
                        for (const record of raw.data) {
                            const own = record[relation.association] || [];
                            associationsByProduct.set(`${record.id}:${relation.association}`, own.length < 100 ? own : await associationRecords(api, relation, record.id));
                        }
                    }
                    for (const parentId of [...new Set(records.filter(record => record.parentId).map(record => record.parentId))]) {
                        const key = `${parentId}:${relation.association}`;
                        if (!associationsByProduct.has(key)) associationsByProduct.set(key, await associationRecords(api, relation, parentId));
                    }
                }
                planned = records.map(record => {
                    const payload = bulkProductPayload(record, fields, values, selected, price, config.currencyId, taxes); const deletes = {};
                    for (const item of associations) {
                        const { relation } = item; const own = (associationsByProduct.get(`${record.id}:${relation.association}`) || []).map(row => row.id);
                        const parent = (associationsByProduct.get(`${record.parentId}:${relation.association}`) || []).map(row => row.id);
                        const change = bulkAssociationChange(record, relation, own, parent, item.mode.getValue(), item.values.getValue());
                        if (change.add.length) payload[relation.association] = change.add.map(id => ({ id }));
                        if (change.remove.length) deletes[relation.mapping] = change.remove.map(id => ({ productId: record.id, [relation.foreignKey]: id }));
                    }
                    return { payload, deletes };
                });
                form.getForm().getFields().each(field => field.disable());
                }
                for (let index = completed; index < planned.length; index += 100) {
                    dialog.setLoading(`${completed} von ${ids.length} Produkten gespeichert …`);
                    const batch = planned.slice(index, index + 100);
                    const operations = { 'update-products': { entity: 'product', action: 'upsert', payload: batch.map(item => item.payload) } };
                    for (const relation of productAssociations) {
                        const payload = batch.flatMap(item => item.deletes[relation.mapping] || []);
                        if (payload.length) operations[`remove-${relation.mapping}`] = { entity: relation.mapping, action: 'delete', payload };
                    }
                    await api.request('/_action/sync', 'POST', operations); completed += Math.min(100, planned.length - index);
                }
                dialog.destroy(); notify(`${completed} Produkte geändert.`); onSaved();
            } catch (error) {
                if (!dialog.destroyed && api.user) form.down('#error').update(encode(`${completed ? `${completed} Produkte wurden bereits geändert. ` : ''}${error.message}`));
            } finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
        });
    }
}

export async function duplicateProduct(api, config, sourceId, onSaved) {
    const source = (await api.search('product', { ids: [sourceId], limit: 1 })).data[0];
    if (!source) throw new Error('Das Produkt ist nicht mehr vorhanden.');
    let busy = false; let duplicateId;
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, defaults: { xtype: 'textfield', anchor: '100%', labelAlign: 'top', allowBlank: false }, items: [
        { name: 'name', fieldLabel: 'Name der Kopie', value: `${source.name} Kopie` }, { name: 'number', fieldLabel: 'Neue Artikelnummer' },
        { xtype: 'checkboxfield', name: 'variants', boxLabel: 'Varianten ebenfalls kopieren', checked: true },
        { xtype: 'component', html: '<p>Die Kopie und ihre Varianten werden zunächst inaktiv angelegt.</p>' },
        { xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
    ] });
    const dialog = Ext.create('Ext.window.Window', { title: 'Produkt duplizieren', modal: true, constrain: true, layout: 'fit', width: Math.min(560, innerWidth - 24), items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Duplizieren', cls: 'emz-admin__primary', handler: clone }], listeners: { beforeclose: () => !busy },
    }); dialog.show();
    async function clone() {
        if (busy || duplicateId || !form.getForm().isValid()) return;
        const values = form.getForm().getFieldValues(); const number = values.number.trim(); const name = values.name.trim();
        if (!number || !name) return;
        busy = true; dialog.setLoading('Produkt wird kopiert …');
        try {
            const variants = [];
            if (values.variants) for (let page = 1; ; page++) {
                const result = await api.search('product', { page, limit: 100, filter: [{ type: 'equals', field: 'parentId', value: sourceId }], sort: [{ field: 'id', order: 'ASC' }] }); variants.push(...result.data);
                if (page * 100 >= result.total) break;
            }
            const numbers = [number, ...variants.map((variant, index) => `${number}.${index + 1}`)];
            for (let index = 0; index < numbers.length; index += 100) {
                const used = await api.search('product', { limit: 1, filter: [{ type: 'equalsAny', field: 'productNumber', value: numbers.slice(index, index + 100) }] });
                if (used.total) throw new Error(`Die Artikelnummer ${used.data[0].productNumber} ist bereits vergeben.`);
            }
            const result = await api.request(`/_action/clone/product/${sourceId}`, 'POST', { cloneChildren: false, overwrites: {
                productNumber: number, name, active: false, mainVariantId: null, canonicalProductId: null,
                variantListingConfig: source.variantListingConfig ? { ...source.variantListingConfig, mainVariantId: null } : null,
            } }); duplicateId = result.id;
            for (const [index, variant] of variants.entries()) {
                dialog.setLoading(`Variante ${index + 1} von ${variants.length} wird kopiert …`);
                await api.request(`/_action/clone/product/${variant.id}`, 'POST', { cloneChildren: false, overwrites: { parentId: duplicateId, productNumber: numbers[index + 1], active: false } });
            }
            dialog.destroy(); notify('Produktkopie angelegt.'); onSaved(duplicateId);
        } catch (error) {
            if (duplicateId && api.can('product:delete')) { try { await api.request(`/product/${duplicateId}`, 'DELETE'); duplicateId = null; } catch { /* The exact partial copy remains visible in the list. */ } }
            if (!dialog.destroyed && api.user) form.down('#error').update(encode(`${duplicateId ? `Die unvollständige Kopie mit Artikelnummer ${number} bleibt in der Produktliste sichtbar. ` : ''}${error.message}`));
            if (duplicateId) onSaved(duplicateId);
        } finally { busy = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}
