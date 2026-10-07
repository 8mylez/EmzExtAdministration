import { entityField } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, money, notify } from '../ui.js';
import { openEntityEditor } from '../entity-editor.js';
import { customerModules } from './customers.js';

export function createOrder(api, config, onCreated) {
    let channelId;
    let customerId;
    let token;
    let cart;
    let context;
    let busy = false;
    let finished = false;
    const selection = Ext.create('Ext.form.Panel', { title: 'Kunde', bodyPadding: 20, items: [
        entityField(api, { name: 'salesChannelId', label: 'Verkaufskanal', type: 'reference', required: true, reference: { entity: 'sales_channel', filter: [{ type: 'equals', field: 'active', value: true }] } }, null, true),
        entityField(api, { name: 'customerId', label: 'Kunde', type: 'reference', required: true, reference: { entity: 'customer', labelFields: ['email', 'firstName', 'lastName'] } }, null, true),
        { xtype: 'button', text: 'Warenkorb vorbereiten', itemId: 'start', handler: start },
    ] });
    const settings = Ext.create('Ext.form.Panel', { title: 'Bestelldaten', disabled: true, bodyPadding: 20, scrollable: true,
        bbar: [{ text: 'Bestelldaten anwenden', handler: applySettings },
            ...[['billingAddressId', 'Rechnungsadresse bearbeiten'], ['shippingAddressId', 'Lieferadresse bearbeiten']].map(([name, text]) => ({ text,
                disabled: !api.can('customer_address:update'), handler: () => {
                    const id = settings.getForm().findField(name)?.getValue();
                    if (id) openEntityEditor(api, config, customerModules[1], id, () => run(refreshCart));
                } })),
        ] });
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'label', 'quantity', 'unitPrice', 'totalPrice', 'type', 'item'] });
    const positions = Ext.create('Ext.grid.Panel', { title: 'Warenkorb', disabled: true, store, emptyText: 'Noch keine Positionen.', viewConfig: { deferEmptyText: false },
        columns: [{ text: 'Bezeichnung', dataIndex: 'label', flex: 1, renderer: encode }, { text: 'Menge', dataIndex: 'quantity', width: 85 },
            { text: 'Einzelpreis', dataIndex: 'unitPrice', width: 120 }, { text: 'Gesamt', dataIndex: 'totalPrice', width: 120 }],
        tbar: [{ text: 'Produkt hinzufügen', disabled: !api.can('product:read'), handler: () => itemDialog('product') },
            { text: 'Freie Position', handler: () => itemDialog('custom') }, { text: 'Gutschriftposition', handler: () => itemDialog('credit') },
            { text: 'Bearbeiten', handler: () => { const row = positions.getSelection()[0]; if (row) itemDialog(row.get('type'), row.get('item')); } },
            { text: 'Entfernen', handler: () => {
                const row = positions.getSelection()[0];
                if (row) run(async () => { cart = await call('/checkout/cart/line-item', 'DELETE', { ids: [row.id] }); renderCart(); });
            } }],
        bbar: [{ text: 'Aktionscode hinzufügen', handler: () => Ext.Msg.prompt('Aktionscode', 'Code:', (choice, code) => {
            if (choice === 'ok' && code.trim()) run(async () => { cart = await call('/checkout/cart/line-item', 'POST', { items: [{ type: 'promotion', referencedId: code.trim() }] }); renderCart(); });
        }) }, { text: 'Aktualisieren', handler: () => run(refreshCart) }],
        listeners: { itemdblclick: (view, row) => itemDialog(row.get('type'), row.get('item')) },
    });
    const options = Ext.create('Ext.form.Panel', { title: 'Abschluss', disabled: true, bodyPadding: 20, defaults: { anchor: '100%', labelAlign: 'top' }, items: [
        { xtype: 'textareafield', name: 'customerComment', fieldLabel: 'Bestellkommentar' },
        { xtype: 'textfield', name: 'affiliateCode', fieldLabel: 'Affiliate-Code' }, { xtype: 'textfield', name: 'campaignCode', fieldLabel: 'Kampagnen-Code' },
        { xtype: 'checkboxfield', name: 'sendOrderConfirmationMail', boxLabel: 'Bestellbestätigung per E-Mail an den Kunden senden', checked: false },
        { xtype: 'component', html: '<p>Mit „Bestellung verbindlich anlegen“ wird aus diesem Warenkorb eine Bestellung.</p>' },
    ] });
    const tabs = Ext.create('Ext.tab.Panel', { items: [selection, settings, positions, options] });
    const dialog = Ext.create('Ext.window.Window', { title: 'Bestellung anlegen', modal: true, constrain: true, layout: 'fit',
        width: Math.min(1080, window.innerWidth - 24), height: Math.min(800, window.innerHeight - 32), items: [tabs],
        dockedItems: [{ xtype: 'toolbar', dock: 'bottom', items: [{ xtype: 'tbtext', itemId: 'total', text: 'Bitte zuerst Kunde und Verkaufskanal wählen.' }] },
            { xtype: 'component', dock: 'bottom', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' }],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Bestellung verbindlich anlegen', itemId: 'checkout', disabled: true, cls: 'emz-admin__primary', handler: checkout }],
        listeners: { beforeclose: () => {
            if (finished) return true;
            if (busy) return false;
            if (!token) return true;
            Ext.Msg.confirm('Warenkorb verwerfen?', 'Der vorbereitete Warenkorb wird gelöscht.', choice => {
                if (choice === 'yes') run(async () => { await call('/checkout/cart', 'DELETE'); finished = true; dialog.destroy(); });
            }); return false;
        }, destroy: () => store.destroy() },
    }); dialog.show();

    function call(path, method = 'GET', payload) {
        return api.request(`/_proxy/store-api/${channelId}${path}`, method, payload, { headers: token ? { 'sw-context-token': token } : {} });
    }
    async function run(action) {
        if (busy || dialog.destroyed) return;
        busy = true; dialog.setLoading('Bestellung wird vorbereitet …'); dialog.down('#error').update('');
        try { await action(); }
        catch (error) { if (!dialog.destroyed && api.user) dialog.down('#error').update(encode(error.message)); }
        finally { busy = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
    async function start() {
        if (!selection.getForm().isValid()) return;
        await run(async () => {
            const values = selection.getForm().getFieldValues();
            if (token) await call('/checkout/cart', 'DELETE');
            channelId = values.salesChannelId; customerId = values.customerId; token = null;
            cart = await call('/checkout/cart'); token = cart.token;
            await api.request('/_proxy/switch-customer', 'PATCH', { customerId, salesChannelId: channelId, permissions: ['allowProductPriceOverwrites'] }, { headers: { 'sw-context-token': token } });
            context = await call('/context');
            buildSettings();
            await refreshCart();
            selection.getForm().getFields().each(field => field.setReadOnly(true)); selection.down('#start').disable();
            [settings, positions, options].forEach(panel => panel.enable()); tabs.setActiveTab(positions);
        });
    }
    function buildSettings() {
        const specs = [
            ['currencyId', 'Währung', 'currency', context.currency?.id || context.context?.currencyId, ['isoCode', 'name']],
            ['languageId', 'Sprache', 'language', context.context?.languageIdChain?.[0], ['name']],
            ['paymentMethodId', 'Zahlungsart', 'payment_method', context.paymentMethod?.id, ['name']],
            ['shippingMethodId', 'Versandart', 'shipping_method', context.shippingMethod?.id, ['name']],
            ['billingAddressId', 'Rechnungsadresse', 'customer_address', context.customer?.activeBillingAddress?.id, ['street', 'zipcode', 'city']],
            ['shippingAddressId', 'Lieferadresse', 'customer_address', context.customer?.activeShippingAddress?.id, ['street', 'zipcode', 'city']],
        ];
        settings.removeAll();
        settings.add(specs.map(([name, label, entity, value, labelFields]) => entityField(api, { name, label, type: 'reference', required: true,
            reference: { entity, labelFields, filter: entity === 'customer_address' ? [{ type: 'equals', field: 'customerId', value: customerId }] : [] } }, value, true)));
        settings.add({ xtype: 'numberfield', name: 'shippingCosts', fieldLabel: 'Versandkosten überschreiben (optional)', labelAlign: 'top', anchor: '100%', minValue: 0, decimalPrecision: 8, readOnly: !api.can('order:update') });
        settings.add({ xtype: 'checkboxfield', name: 'disableAutomaticPromotions', boxLabel: 'Automatische Rabatte deaktivieren', checked: false, readOnly: !api.can('order:update') });
        settings.getForm().getFields().each(field => field.resetOriginalValue());
    }
    async function applySettings() {
        if (!settings.getForm().isValid()) return;
        await run(async () => {
            const { shippingCosts, disableAutomaticPromotions, ...values } = settings.getForm().getFieldValues();
            await call('/context', 'PATCH', values);
            const headers = { 'sw-context-token': token };
            if (settings.getForm().findField('disableAutomaticPromotions').isDirty()) await api.request(`/_proxy/${disableAutomaticPromotions ? 'disable' : 'enable'}-automatic-promotions`, 'PATCH', { salesChannelId: channelId }, { headers });
            if (shippingCosts !== null) await api.request('/_proxy/modify-shipping-costs', 'PATCH', { salesChannelId: channelId,
                shippingCosts: { unitPrice: shippingCosts, totalPrice: shippingCosts } }, { headers });
            context = await call('/context'); await refreshCart();
            settings.getForm().getFields().each(field => field.resetOriginalValue());
            notify('Bestelldaten angewendet.');
        });
    }
    async function refreshCart() { cart = await call('/checkout/cart'); renderCart(); }
    function renderCart() {
        if (dialog.destroyed) return;
        store.loadData((cart.lineItems || []).map(item => ({ id: item.id, label: item.label, quantity: item.quantity, type: item.type,
            unitPrice: item.price?.unitPrice, totalPrice: item.price?.totalPrice, item })));
        const errors = Object.values(cart.errors || {});
        dialog.down('#error').update(errors.map(error => encode(error.translatedMessage || error.message || error.messageKey)).join('<br>'));
        dialog.down('#checkout').setDisabled(!cart.lineItems?.length || errors.some(error => error.block));
        const currency = context?.currency?.isoCode || config.currencyCode;
        dialog.down('#total').setText(`Gesamt: ${encode(money(cart.price?.totalPrice || 0, currency))} · Versand: ${encode(money((cart.deliveries || []).reduce((sum, delivery) => sum + (delivery.shippingCosts?.totalPrice || 0), 0), currency))}`);
    }
    async function checkout() {
        if (settings.getForm().isDirty()) { dialog.down('#error').update('Bitte geänderte Bestelldaten zuerst anwenden.'); tabs.setActiveTab(settings); return; }
        await run(async () => {
            const values = options.getForm().getFieldValues();
            const order = await api.request(`/_proxy-order/${channelId}`, 'POST', { ...values, sendOrderConfirmationMail: Boolean(values.sendOrderConfirmationMail) }, { headers: { 'sw-context-token': token } });
            finished = true; dialog.destroy(); notify(`Bestellung ${order.orderNumber || ''} angelegt.`); onCreated(order.id);
        });
    }
    function itemDialog(type, original) {
        if (!['product', 'custom', 'credit'].includes(type)) { notify('Rabattpositionen werden über den Aktionscode verwaltet.'); return; }
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, defaults: { anchor: '100%', labelAlign: 'top' }, items: [
            ...(type === 'product' && !original ? [entityField(api, { name: 'productId', label: 'Produkt', type: 'reference', required: true,
                reference: { entity: 'product', labelFields: ['productNumber', 'name'] } }, null, true)] : [
                { xtype: 'textfield', name: 'label', fieldLabel: 'Bezeichnung', value: original?.label || '', allowBlank: false },
                { xtype: 'numberfield', name: 'price', fieldLabel: type === 'credit' ? 'Gutschriftbetrag (negativ)' : 'Einzelpreis in Bestellwährung', value: original?.price?.unitPrice ?? null,
                    allowBlank: false, decimalPrecision: 8, ...(type === 'credit' ? { maxValue: -0.01 } : { minValue: 0 }) },
                ...(type !== 'credit' ? [{ xtype: 'numberfield', name: 'taxRate', fieldLabel: 'Steuersatz (%)', value: original?.price?.taxRules?.[0]?.taxRate || 0, minValue: 0, maxValue: 100, allowBlank: false }] : []),
            ]),
            { xtype: 'numberfield', name: 'quantity', fieldLabel: 'Menge', value: original?.quantity || 1, minValue: 1, allowDecimals: false, allowBlank: false, readOnly: type === 'credit' },
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
        ] });
        let saving = false;
        const editor = Ext.create('Ext.window.Window', { title: 'Warenkorbposition', modal: true, width: Math.min(560, window.innerWidth - 24), layout: 'fit', items: [form],
            buttons: [{ text: 'Abbrechen', handler: () => editor.close() }, { text: 'Position übernehmen', handler: async () => {
                if (saving || !form.getForm().isValid()) return;
                saving = true; editor.setLoading('Position wird berechnet …');
                try {
                    const values = form.getForm().getFieldValues();
                    const item = { id: original?.id || values.productId || uuid(), type, quantity: values.quantity, stackable: true, removable: true,
                        referencedId: original?.referencedId || values.productId || null };
                    if (!(type === 'product' && !original)) Object.assign(item, { label: values.label.trim(), priceDefinition: {
                        type: type === 'credit' ? 'absolute' : 'quantity', price: values.price, quantity: values.quantity,
                        taxRules: [{ taxRate: values.taxRate || 0, percentage: 100 }], isCalculated: true,
                    } });
                    cart = await call('/checkout/cart/line-item', original ? 'PATCH' : 'POST', { items: [item] });
                    renderCart(); editor.destroy();
                } catch (error) { if (!editor.destroyed && api.user) form.down('#error').update(encode(error.message)); }
                finally { saving = false; if (!editor.destroyed) editor.setLoading(false); }
            } }], listeners: { beforeclose: () => !saving },
        }); editor.show();
    }
}
