import { entityField } from '../entity-fields.js';
import { entityListView } from '../entity-list.js';
import { openEntityEditor } from '../entity-editor.js';
import { uuid } from '../entity-data.js';
import { encode, money, notify, showError } from '../ui.js';
import { relationPanel } from '../relation-panel.js';

export async function editOrder(api, config, orderId, onSaved) {
    const draftKey = `emz.ext-admin.order-draft:${api.user?.id}:${orderId}`;
    let versionId = sessionStorage.getItem(draftKey);
    const resumed = Boolean(versionId);
    try {
        if (versionId) {
            const response = await api.search('order', { ids: [orderId], limit: 1 }, { headers: { 'sw-version-id': versionId } });
            if (!response.data.length) versionId = null;
        }
        if (!versionId) versionId = (await api.request(`/_action/version/order/${orderId}`, 'POST', {})).versionId;
        sessionStorage.setItem(draftKey, versionId);
    }
    catch (error) { if (api.user) showError(error); return; }
    const headers = { 'sw-version-id': versionId };
    let dirty = resumed;
    let needsCalculation = true;
    let busy = false;
    let finished = false;
    const versionApi = {
        get user() { return api.user; }, can: privilege => api.can(privilege),
        search: (entity, criteria, options = {}) => api.search(entity, criteria, { ...options, headers: { ...options.headers, ...headers } }),
        request: async (path, method, payload, options = {}) => {
            const response = await api.request(path, method, payload, { ...options, headers: { ...options.headers, ...headers } });
            if (['PATCH', 'POST', 'DELETE'].includes(method) && !path.startsWith('/search/')) { dirty = true; needsCalculation = true; }
            return response;
        },
    };
    const positions = entityListView(versionApi, config, {
        title: 'Positionen', singular: 'Position', entity: 'order_line_item', create: false,
        filter: [{ type: 'equals', field: 'orderId', value: orderId }], search: ['label'], sort: 'position', direction: 'ASC',
        columns: [{ field: 'label', label: 'Bezeichnung' }, { field: 'quantity', label: 'Menge', width: 85 },
            { field: 'price.unitPrice', label: 'Einzelpreis', width: 120 }, { field: 'price.totalPrice', label: 'Gesamt', width: 120 }, { field: 'type', label: 'Typ', width: 100 }],
        fields: [], editor: editPosition,
    });
    positions.setTitle('Positionen');
    positions.addDocked({ xtype: 'toolbar', dock: 'top', enableOverflow: true, items: [
        { text: 'Produkt hinzufügen', disabled: !api.can('order_line_item:create') || !api.can('product:read'), handler: () => addPosition('product') },
        { text: 'Freie Position', disabled: !api.can('order_line_item:create'), handler: () => addPosition('custom') },
        { text: 'Gutschriftposition', disabled: !api.can('order_line_item:create'), handler: () => addPosition('credit') },
        { text: 'Aktionscode', handler: () => Ext.Msg.prompt('Aktionscode', 'Code für diese Bestellung:', (choice, code) => {
            if (choice === 'ok' && code.trim()) run(() => versionApi.request(`/_action/order/${orderId}/promotion-item`, 'POST', { code: code.trim() }));
        }) },
    ] });
    const tabs = [positions];
    if (api.can('order_address:read')) {
        const addresses = entityListView(versionApi, config, { title: 'Adressen', singular: 'Bestelladresse', entity: 'order_address', create: false, delete: false,
            filter: [{ type: 'equals', field: 'orderId', value: orderId }], search: [], sort: 'createdAt', direction: 'ASC',
            columns: [{ field: 'firstName', label: 'Vorname' }, { field: 'lastName', label: 'Nachname' }, { field: 'street', label: 'Straße' }, { field: 'city', label: 'Ort' }],
            fields: [{ name: 'firstName', label: 'Vorname', required: true }, { name: 'lastName', label: 'Nachname', required: true },
                { name: 'company', label: 'Firma' }, { name: 'department', label: 'Abteilung' }, { name: 'street', label: 'Straße', required: true },
                { name: 'zipcode', label: 'Postleitzahl' }, { name: 'city', label: 'Ort', required: true }, { name: 'phoneNumber', label: 'Telefon' },
                { name: 'countryId', label: 'Land', type: 'reference', required: true, reference: { entity: 'country' } },
                { name: 'countryStateId', label: 'Bundesland', type: 'reference', reference: { entity: 'country_state' } },
                { name: 'additionalAddressLine1', label: 'Adresszusatz 1' }, { name: 'additionalAddressLine2', label: 'Adresszusatz 2' }],
        }); addresses.setTitle('Adressen'); tabs.push(addresses);
        addresses.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'Aus Kundenadresse übernehmen', disabled: !api.can('customer_address:read') || !api.can('order_address:update'), handler: async () => {
            const addressId = addresses.getSelection()[0]?.id; if (!addressId) { notify('Bitte eine Bestelladresse auswählen.'); return; }
            try {
                const customer = (await versionApi.search('order-customer', { limit: 1, filter: [{ type: 'equals', field: 'orderId', value: orderId }] })).data[0];
                if (!customer?.customerId) throw new Error('Diese Bestellung ist keinem bestehenden Kundenkonto zugeordnet.');
                const field = entityField(versionApi, { name: 'address', label: 'Kundenadresse', type: 'reference', required: true, reference: { entity: 'customer_address', labelFields: ['street', 'zipcode', 'city'], filter: [{ type: 'equals', field: 'customerId', value: customer.customerId }] } }, null, true);
                let copying = false;
                const picker = Ext.create('Ext.window.Window', { title: 'Kundenadresse übernehmen', modal: true, width: Math.min(570, innerWidth - 24), bodyPadding: 20, layout: 'anchor', items: [field],
                    buttons: [{ text: 'Abbrechen', handler: () => picker.close() }, { text: 'Übernehmen', handler: async () => {
                        if (copying || !field.isValid()) return; copying = true; picker.setLoading('Adresse wird übernommen …');
                        try { await versionApi.request(`/_action/order-address/${addressId}/customer-address/${field.getValue()}`, 'POST', {}); picker.destroy(); addresses.refreshRecords(); }
                        catch (error) { if (api.user) showError(error); } finally { copying = false; if (!picker.destroyed) picker.setLoading(false); }
                    } }], listeners: { beforeclose: () => !copying } }); picker.show();
            } catch (error) { if (api.user) showError(error); }
        } }] });
    }
    if (api.can('order_delivery:read')) {
        const deliveries = entityListView(versionApi, config, { title: 'Versand', singular: 'Lieferung', entity: 'order_delivery', create: false, delete: false,
            filter: [{ type: 'equals', field: 'orderId', value: orderId }], search: [], sort: 'createdAt',
            columns: [{ field: 'shippingDateEarliest', label: 'Frühestes Lieferdatum', type: 'date' }, { field: 'shippingDateLatest', label: 'Spätestes Lieferdatum', type: 'date' }],
            fields: [{ name: 'shippingMethodId', label: 'Versandart', type: 'reference', required: true, reference: { entity: 'shipping_method' } },
                { name: 'shippingOrderAddressId', label: 'Lieferadresse', type: 'reference', required: true, reference: { entity: 'order_address', labelFields: ['street', 'zipcode', 'city'], filter: [{ type: 'equals', field: 'orderId', value: orderId }] } },
                { name: 'shippingAmount', label: 'Versandkosten in Bestellwährung', type: 'number', min: 0, required: true, initialValue: row => row.shippingCosts?.totalPrice },
                { name: 'shippingDateEarliest', label: 'Frühestes Lieferdatum', type: 'date', required: true }, { name: 'shippingDateLatest', label: 'Spätestes Lieferdatum', type: 'date', required: true },
                { name: 'trackingCodes', label: 'Tracking-Codes (einer pro Zeile)', type: 'lines' }],
            prepare: (payload, original, { values }) => {
                if (values.shippingDateLatest < values.shippingDateEarliest) throw new Error('Das späteste Lieferdatum darf nicht vor dem frühesten liegen.');
                if ('shippingAmount' in payload) payload.shippingCosts = { unitPrice: payload.shippingAmount, totalPrice: payload.shippingAmount, quantity: 1,
                    calculatedTaxes: (original.shippingCosts?.calculatedTaxes || []).map(({ tax, taxRate, price }) => ({ tax, taxRate, price })),
                    taxRules: (original.shippingCosts?.taxRules || []).map(({ taxRate, percentage }) => ({ taxRate, percentage })) };
                delete payload.shippingAmount; return payload;
            },
        }); deliveries.setTitle('Versand'); tabs.push(deliveries);
    }
    if (api.can('order_transaction:read')) {
        const payments = entityListView(versionApi, config, { title: 'Zahlungsdaten', singular: 'Zahlungsdaten', entity: 'order_transaction', create: false, delete: false,
            filter: [{ type: 'equals', field: 'orderId', value: orderId }], search: [], sort: 'createdAt',
            associations: { ...(api.can('payment_method:read') ? { paymentMethod: {} } : {}), ...(api.can('state_machine_state:read') ? { stateMachineState: {} } : {}) },
            columns: [{ field: 'paymentMethod.name', label: 'Zahlungsart' }, { field: 'stateMachineState.name', label: 'Status' }, { field: 'amount.totalPrice', label: 'Betrag' }],
            fields: [{ name: 'paymentMethodId', label: 'Zahlungsart', type: 'reference', required: true, reference: { entity: 'payment_method' } }],
        }); payments.setTitle('Zahlungsdaten'); tabs.push(payments);
    }
    const dialog = Ext.create('Ext.window.Window', { title: 'Bestellung bearbeiten', modal: true, constrain: true, layout: 'fit',
        width: Math.min(1080, window.innerWidth - 24), height: Math.min(760, window.innerHeight - 32),
        items: [{ xtype: 'tabpanel', items: tabs }],
        tbar: [{ text: 'Bestelldaten', handler: () => openEntityEditor(versionApi, config, { entity: 'order', singular: 'Bestelldaten', fields: [
            { name: 'orderDateTime', label: 'Bestelldatum', type: 'datetime', required: true },
            { name: 'billingAddressId', label: 'Rechnungsadresse', type: 'reference', required: true, reference: { entity: 'order_address', labelFields: ['street', 'zipcode', 'city'], filter: [{ type: 'equals', field: 'orderId', value: orderId }] } },
            { name: 'internalComment', label: 'Interner Kommentar', type: 'textarea' }, { name: 'affiliateCode', label: 'Partnercode' }, { name: 'campaignCode', label: 'Kampagnencode' },
        ], detailTabs: () => api.can('tag:read') ? [relationPanel(versionApi, config, { entity: 'order', id: orderId }, { title: 'Tags', entity: 'tag', reverse: 'orders', mapping: 'order_tag', association: 'tags' })] : [] }, orderId, refresh) },
        { text: 'Kundendaten', disabled: !api.can('order_customer:read'), handler: async () => {
            try {
                const customer = (await versionApi.search('order-customer', { limit: 1, filter: [{ type: 'equals', field: 'orderId', value: orderId }] })).data[0];
                if (!customer) throw new Error('Die Bestellkundendaten sind nicht mehr vorhanden.');
                openEntityEditor(versionApi, config, { entity: 'order_customer', singular: 'Bestellkundendaten', fields: [
                    { name: 'firstName', label: 'Vorname', required: true }, { name: 'lastName', label: 'Nachname', required: true }, { name: 'email', label: 'E-Mail', type: 'email', required: true },
                    { name: 'company', label: 'Firma' }, { name: 'vatIds', label: 'Umsatzsteuer-IDs (eine pro Zeile)', type: 'lines' },
                ] }, customer.id, refresh);
            } catch (error) { if (api.user) showError(error); }
        } }],
        dockedItems: [{ xtype: 'toolbar', dock: 'bottom', items: [{ xtype: 'tbtext', itemId: 'total', text: 'Bestelländerungen werden erst beim Übernehmen wirksam.' }] },
            { xtype: 'component', dock: 'bottom', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' }],
        buttons: [{ text: 'Verwerfen', handler: () => dialog.close() }, { text: 'Neu berechnen', handler: () => run(recalculate) },
            { text: 'Änderungen übernehmen', cls: 'emz-admin__primary', handler: commit }],
        listeners: { beforeclose: () => {
            if (finished) return true;
            if (busy) return false;
            if (dirty) Ext.Msg.confirm('Bestelländerungen verwerfen?', 'Alle Änderungen dieses Entwurfs werden verworfen.', choice => { if (choice === 'yes') discard(); });
            else discard();
            return false;
        } },
    });
    if (!api.user) { dialog.destroy(); return; }
    dialog.show();

    async function refresh() {
        const current = (await versionApi.search('order', { ids: [orderId], limit: 1, associations: api.can('currency:read') ? { currency: {} } : {} })).data[0];
        if (!dialog.destroyed) {
            dialog.down('#total').setText(`Gesamt: ${encode(current.currency?.isoCode ? money(current.amountTotal, current.currency.isoCode) : current.amountTotal)} · Änderungen noch nicht übernommen`);
            positions.refreshRecords();
        }
    }
    async function recalculate() {
        const response = await versionApi.request(`/_action/order/${orderId}/recalculate`, 'POST', {});
        const errors = Object.values(response?.errors || {});
        const message = errors.map(error => error.translatedMessage || error.message || error.messageKey || 'Berechnung nicht möglich.').join('\n');
        if (errors.some(error => error.level > 10)) throw new Error(message);
        if (!dialog.destroyed) dialog.down('#error').update(encode(message));
        needsCalculation = false;
    }
    async function run(action) {
        if (busy || finished || dialog.destroyed) return;
        busy = true; dialog.setLoading('Bestellung wird berechnet …'); dialog.down('#error').update('');
        try { await action(); if (!finished) await refresh(); }
        catch (error) { if (!dialog.destroyed && api.user) dialog.down('#error').update(encode(error.message)); }
        finally { busy = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
    async function commit() {
        if (needsCalculation) {
            await run(recalculate);
            if (!needsCalculation) notify('Bitte die berechneten Beträge prüfen und anschließend die Änderungen übernehmen.');
            return;
        }
        await run(async () => {
            await api.request(`/_action/version/merge/order/${versionId}`, 'POST', {});
            finished = true; sessionStorage.removeItem(draftKey); dialog.destroy(); notify('Bestelländerungen übernommen.'); onSaved();
        });
    }
    async function discard() {
        await run(async () => {
            await api.request(`/_action/version/${versionId}/order/${orderId}`, 'POST', {});
            finished = true; sessionStorage.removeItem(draftKey); dialog.destroy();
        });
    }
    async function editPosition(api, config, definition, id, refreshList) {
        const position = (await api.search('order-line-item', { ids: [id], limit: 1 })).data[0];
        if (!position) return;
        if (!['product', 'custom', 'credit'].includes(position.type)) {
            await openEntityEditor(api, config, { ...definition, fields: [{ name: 'label', label: 'Bezeichnung', readOnly: true }, { name: 'type', label: 'Typ', readOnly: true },
                { name: 'quantity', label: 'Menge', type: 'integer', readOnly: true }, { name: 'payload', label: 'Daten der Erweiterung oder Rabattregel', type: 'json', readOnly: true }] }, id, refreshList); return;
        }
        const fields = [{ name: 'label', label: 'Bezeichnung', required: true }, { name: 'quantity', label: 'Menge', type: 'integer', min: 1, required: true },
            { name: 'unitPrice', label: 'Einzelpreis in Bestellwährung', type: 'number', required: true, initialValue: row => row.priceDefinition?.price ?? row.price?.unitPrice },
            ...(position.type !== 'credit' && (position.priceDefinition?.taxRules || []).length <= 1 ? [{ name: 'taxRate', label: 'Steuersatz (%)', type: 'number', min: 0, max: 100, required: true,
                initialValue: row => row.priceDefinition?.taxRules?.[0]?.taxRate || 0 }] : []),
            { name: 'description', label: 'Beschreibung', type: 'textarea' }];
        await openEntityEditor(api, config, { ...definition, fields, prepare: (payload, original, { values }) => {
            if ('unitPrice' in payload || 'quantity' in payload || 'taxRate' in payload) {
                const price = values.unitPrice;
                if ((original.type === 'credit' && price >= 0) || (original.type !== 'credit' && price < 0)) throw new Error('Gutschriften benötigen einen negativen, andere Positionen einen nicht negativen Preis.');
                payload.priceDefinition = original.type === 'credit' ? { ...original.priceDefinition, price } : {
                    type: 'quantity', price, quantity: values.quantity, isCalculated: true,
                    taxRules: 'taxRate' in payload ? [{ taxRate: values.taxRate, percentage: 100 }] : (original.priceDefinition?.taxRules || original.price?.taxRules || []).map(rule => ({ taxRate: rule.taxRate, percentage: rule.percentage })),
                    referencePriceDefinition: original.priceDefinition?.referencePriceDefinition ?? null,
                    listPrice: original.priceDefinition?.listPrice ?? null, regulationPrice: original.priceDefinition?.regulationPrice ?? null,
                };
                delete payload.priceDefinition.apiAlias; delete payload.priceDefinition.extensions;
            }
            delete payload.unitPrice; delete payload.taxRate; return payload;
        } }, id, refreshList);
    }
    function addPosition(type) {
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, defaults: { anchor: '100%', labelAlign: 'top' }, items: [
            ...(type === 'product' ? [entityField(api, { name: 'productId', label: 'Produkt', type: 'reference', required: true,
                reference: { entity: 'product', labelFields: ['productNumber', 'name'] } }, null, true)] : [
                { xtype: 'textfield', name: 'label', fieldLabel: 'Bezeichnung', allowBlank: false },
                { xtype: 'numberfield', name: 'price', fieldLabel: type === 'credit' ? 'Gutschriftbetrag (negativ)' : 'Einzelpreis in Bestellwährung', allowBlank: false, decimalPrecision: 8,
                    ...(type === 'credit' ? { maxValue: -0.01 } : { minValue: 0 }) },
                ...(type === 'custom' ? [{ xtype: 'numberfield', name: 'taxRate', fieldLabel: 'Steuersatz (%)', minValue: 0, maxValue: 100, value: 0, allowBlank: false }] : []),
            ]),
            { xtype: 'numberfield', name: 'quantity', fieldLabel: 'Menge', value: 1, minValue: 1, allowDecimals: false, allowBlank: false, readOnly: type === 'credit' },
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
        ] });
        let saving = false;
        const editor = Ext.create('Ext.window.Window', { title: 'Bestellposition hinzufügen', modal: true, width: Math.min(570, window.innerWidth - 24), layout: 'fit', items: [form],
            buttons: [{ text: 'Abbrechen', handler: () => editor.close() }, { text: 'Position hinzufügen', handler: async () => {
                if (saving || !form.getForm().isValid()) return;
                saving = true; editor.setLoading('Position wird hinzugefügt …');
                try {
                    const values = form.getForm().getFieldValues();
                    const path = type === 'product' ? `product/${values.productId}` : type === 'credit' ? 'creditItem' : 'lineItem';
                    const payload = type === 'product' ? { quantity: values.quantity } : { identifier: uuid(), type, label: values.label.trim(), quantity: values.quantity,
                        priceDefinition: { price: values.price, type: type === 'credit' ? 'absolute' : 'quantity', isCalculated: true,
                            quantity: values.quantity, taxRules: [{ taxRate: values.taxRate || 0, percentage: 100 }] } };
                    await versionApi.request(`/_action/order/${orderId}/${path}`, 'POST', payload);
                    editor.destroy(); await run(async () => {});
                } catch (error) { if (!editor.destroyed && api.user) form.down('#error').update(encode(error.message)); }
                finally { saving = false; if (!editor.destroyed) editor.setLoading(false); }
            } }], listeners: { beforeclose: () => !saving },
        }); editor.show();
    }
}
