import { entityListView } from '../entity-list.js';
import { entityField } from '../entity-fields.js';
import { encode, money, notify, showError } from '../ui.js';
import { editOrder } from './order-edit.js';
import { createOrder } from './order-create.js';
import { orderRefunds } from './order-refunds.js';

const orderAmount = (value, currency) => currency ? money(value, currency)
    : new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const documentFormat = type => type?.startsWith('zugferd_') && !type.startsWith('zugferd_embedded_') ? 'xml' : 'pdf';

function associations(api) {
    return Object.fromEntries([
        ['orderCustomer', 'order_customer'], ['currency', 'currency'], ['stateMachineState', 'state_machine_state'],
        ['billingAddress', 'order_address'],
    ].filter(([, entity]) => api.can(`${entity}:read`)).map(([name]) => [name, {}]));
}

export const orderModule = {
    id: 'orders', title: 'Bestellungen', singular: 'Bestellung', entity: 'order', group: 'Bestellungen', icon: 'x-fa fa-shopping-bag',
    search: ['orderNumber'], sort: 'orderDateTime', direction: 'DESC', create: false, delete: false, labelFields: ['orderNumber'],
    columns: [{ field: 'orderNumber', label: 'Bestellnummer', width: 150 }, { field: 'orderCustomer.email', label: 'Kunde' },
        { field: 'amountTotal', label: 'Gesamt', width: 150, render: (value, row) => orderAmount(value, row.currency?.isoCode) },
        { field: 'stateMachineState.name', label: 'Status', width: 150 }, { field: 'orderDateTime', label: 'Bestelldatum', type: 'date', width: 180 }],
    fields: [], editor: openOrder,
    view: (api, config) => {
        const grid = entityListView(api, config, { ...orderModule, associations: associations(api) });
        grid.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'Bestellung anlegen',
            disabled: !['order:create', 'customer:read', 'sales_channel:read', 'api_proxy_switch-customer'].every(privilege => api.can(privilege)),
            handler: () => createOrder(api, config, id => { grid.refreshRecords(); openOrder(api, config, orderModule, id, () => grid.refreshRecords()); }),
        }] }); return grid;
    },
};

async function openOrder(api, config, definition, id, onSaved) {
    if (!id) return;
    let order;
    try {
        order = (await api.search('order', { ids: [id], limit: 1, associations: associations(api) })).data[0];
        if (!order) throw new Error('Die Bestellung ist nicht mehr vorhanden.');
    } catch (error) { if (api.user) showError(error); return; }
    if (!api.user) return;
    const canWrite = api.can('order:update');
    const info = Ext.create('Ext.form.Panel', { title: 'Übersicht', bodyPadding: 20, scrollable: true,
        defaults: { xtype: 'textfield', anchor: '100%', labelAlign: 'top', readOnly: true }, items: [
            { xtype: 'component', html: `<h2 class="emz-admin__heading">Bestellung ${encode(order.orderNumber)}</h2><p>${encode(order.orderCustomer?.firstName)} ${encode(order.orderCustomer?.lastName)} · ${encode(order.orderCustomer?.email)}</p>` },
            { xtype: 'displayfield', fieldLabel: 'Gesamtbetrag', value: encode(orderAmount(order.amountTotal, order.currency?.isoCode)) },
            { xtype: 'displayfield', fieldLabel: 'Status', itemId: 'state', value: encode(order.stateMachineState?.name || '—') },
            { xtype: 'button', text: 'Bestellstatus ändern', disabled: !canWrite,
                handler: () => stateDialog(api, 'order', id, 'Bestellstatus', state => { info.down('#state').setValue(encode(state.name)); onSaved(); }) },
            { xtype: 'component', html: addressHtml(order.billingAddress), margin: '16 0' },
            { xtype: 'textareafield', fieldLabel: 'Kundenkommentar', value: order.customerComment || '', height: 90 },
            { xtype: 'textareafield', name: 'internalComment', fieldLabel: 'Interner Kommentar', readOnly: !canWrite, value: order.internalComment || '', height: 150 },
            { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
        ] });
    const tabs = [info];
    if (api.can('order_line_item:read')) tabs.push(lineItems(api, config, id));
    if (api.can('order_delivery:read')) tabs.push(stateList(api, config, id, 'order_delivery', 'Lieferungen', onSaved));
    if (api.can('order_transaction:read')) tabs.push(stateList(api, config, id, 'order_transaction', 'Zahlungen', onSaved));
    if (api.can('document:read')) tabs.push(documents(api, config, order));
    if (api.can('order_transaction_capture_refund:read') && api.can('state_machine_state:read')) tabs.push(orderRefunds(api, config, order));
    let saving = false;
    const dialog = Ext.create('Ext.window.Window', {
        title: `Bestellung ${encode(order.orderNumber)}`, modal: true, layout: 'fit', constrain: true,
        width: Math.min(1040, window.innerWidth - 24), height: Math.min(800, window.innerHeight - 32),
        items: [{ xtype: 'tabpanel', items: tabs }],
        tbar: [{ text: 'Bestellung bearbeiten', disabled: !canWrite || !api.can('order_line_item:read'), handler: () => {
            if (info.getForm().isDirty()) { showError(new Error('Bitte den Kommentar zuerst speichern.')); return; }
            editOrder(api, config, id, () => { dialog.destroy(); onSaved(); openOrder(api, config, definition, id, onSaved); });
        } }],
        buttons: [{ text: 'Schließen', handler: () => dialog.close() }, { text: 'Kommentar speichern', cls: 'emz-admin__primary', disabled: !canWrite,
            cls: 'emz-admin__primary', handler: async () => {
                if (saving) return;
                const field = info.getForm().findField('internalComment');
                if (!field.isDirty()) return;
                saving = true;
                dialog.setLoading('Kommentar wird gespeichert …');
                try {
                    await api.request(`/order/${id}`, 'PATCH', { internalComment: field.getValue() });
                    if (!dialog.destroyed) { field.resetOriginalValue(); notify('Kommentar gespeichert.'); onSaved(); }
                } catch (error) { if (!dialog.destroyed && api.user) info.down('#error').update(encode(error.message)); }
                finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
            } }],
        listeners: { beforeclose: () => {
            if (saving) return false;
            if (!info.getForm().isDirty()) return true;
            Ext.Msg.confirm('Änderungen verwerfen?', 'Der ungespeicherte Kommentar geht verloren.', choice => { if (choice === 'yes') dialog.destroy(); });
            return false;
        } },
    });
    info.getForm().getFields().each(field => field.resetOriginalValue());
    dialog.show();
}

function addressHtml(address) {
    if (!address) return '';
    return `<h3>Rechnungsadresse</h3><p>${[`${address.firstName} ${address.lastName}`, address.company, address.street, `${address.zipcode || ''} ${address.city}`]
        .filter(Boolean).map(encode).join('<br>')}</p>`;
}

function lineItems(api, config, orderId) {
    const fields = [
        { name: 'label', label: 'Bezeichnung', readOnly: true }, { name: 'quantity', label: 'Menge', type: 'integer', readOnly: true },
        { name: 'type', label: 'Typ', readOnly: true }, { name: 'description', label: 'Beschreibung', type: 'textarea', readOnly: true },
    ];
    const panel = entityListView(api, config, {
        title: 'Positionen', singular: 'Position', entity: 'order_line_item', create: false, delete: false,
        search: ['label'], filter: [{ type: 'equals', field: 'orderId', value: orderId }], sort: 'position', direction: 'ASC', fields,
        columns: [{ field: 'label', label: 'Bezeichnung' }, { field: 'quantity', label: 'Menge', width: 90 },
            { field: 'price.unitPrice', label: 'Einzelpreis', width: 120 }, { field: 'price.totalPrice', label: 'Gesamtpreis', width: 130 }, { field: 'type', label: 'Typ', width: 140 }],
    });
    panel.setTitle('Positionen');
    return panel;
}

function stateList(api, config, orderId, entity, title, onSaved) {
    const panel = entityListView(api, config, {
        title, singular: entity === 'order_delivery' ? 'Lieferung' : 'Zahlung', entity, create: false, delete: false,
        search: [], filter: [{ type: 'equals', field: 'orderId', value: orderId }], sort: 'createdAt', direction: 'DESC',
        associations: api.can('state_machine_state:read') ? { stateMachineState: {} } : {},
        fields: [{ name: 'id', label: 'ID', readOnly: true }],
        columns: [{ field: 'stateMachineState.name', label: 'Status' }, { field: 'createdAt', label: 'Erstellt', type: 'date', width: 180 }],
        editor: (api, config, definition, id) => stateDialog(api, entity, id, title, () => { panel.refreshRecords(); onSaved(); }),
    });
    panel.setTitle(title);
    return panel;
}

async function stateDialog(api, entity, id, title, onChanged) {
    if (!id) return;
    let transitions;
    try { transitions = (await api.request(`/_action/state-machine/${entity}/${id}/state`)).transitions; }
    catch (error) { if (api.user) showError(error); return; }
    if (!api.user) return;
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, items: [
        { xtype: 'combobox', name: 'transition', fieldLabel: 'Neuer Status', labelAlign: 'top', anchor: '100%',
            queryMode: 'local', editable: false, forceSelection: true, allowBlank: false,
            store: transitions.map(item => [item.actionName, item.name]), readOnly: !api.can(`${entity}:update`) },
        { xtype: 'checkboxfield', name: 'sendMail', boxLabel: 'Status-E-Mail an Kunden senden', checked: false },
        { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
    ] });
    let saving = false;
    const dialog = Ext.create('Ext.window.Window', { title, modal: true, layout: 'fit', width: Math.min(540, window.innerWidth - 24), items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Status ändern', cls: 'emz-admin__primary',
            disabled: !api.can(`${entity}:update`) || !transitions.length, handler: async () => {
                if (saving || !form.getForm().isValid()) return;
                saving = true;
                dialog.setLoading('Status wird geändert …');
                try {
                    const values = form.getForm().getFieldValues();
                    const response = await api.request(`/_action/${entity}/${id}/state/${encodeURIComponent(values.transition)}`, 'POST', { sendMail: Boolean(values.sendMail) });
                    dialog.destroy();
                    notify('Status geändert.');
                    onChanged(response);
                } catch (error) { if (!dialog.destroyed && api.user) form.down('#error').update(encode(error.message)); }
                finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
            } }], listeners: { beforeclose: () => !saving },
    });
    dialog.show();
}

function sendDocument(api, order, documentId, onSent) {
    let sending = false;
    const template = entityField(api, { name: 'templateId', label: 'E-Mail-Vorlage', type: 'reference', required: true, reference: { entity: 'mail_template', labelFields: ['description', 'subject'] } }, null, true);
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, items: [template,
        entityField(api, { name: 'recipient', label: 'Empfänger', type: 'email', required: true }, order.orderCustomer?.email, true),
        { xtype: 'component', html: '<p>Die gewählte Vorlage wird in der Sprache der Bestellung ausgefüllt. Der ausgewählte Beleg wird angehängt.</p>' },
        { xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
    ] });
    const dialog = Ext.create('Ext.window.Window', { title: 'Beleg per E-Mail senden', modal: true, layout: 'fit', width: Math.min(640, innerWidth - 24), items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'E-Mail jetzt senden', cls: 'emz-admin__primary', handler: async () => {
            if (sending || !form.getForm().isValid()) return;
            sending = true; dialog.setLoading('E-Mail wird gesendet …');
            try {
                const values = form.getForm().getFieldValues(); const options = { headers: { 'sw-language-id': order.languageId } };
                const record = (await api.search('mail-template', { ids: [values.templateId], limit: 1, associations: { media: { limit: 100 } } }, options)).data[0];
                if (!record) throw new Error('Die E-Mail-Vorlage ist nicht mehr vorhanden.');
                await api.request('/_action/mail-template/get-data-and-send', 'POST', {
                    recipients: { [values.recipient]: [order.orderCustomer?.firstName, order.orderCustomer?.lastName].filter(Boolean).join(' ') },
                    salesChannelId: order.salesChannelId, mailTemplateId: record.id, testMode: false,
                    subject: record.translated?.subject || record.subject, senderName: record.translated?.senderName || record.senderName,
                    ...(record.senderMail ? { senderMail: record.senderMail } : {}),
                    mediaIds: (record.media || []).filter(media => media.languageId === order.languageId).map(media => media.mediaId),
                    documentIds: [documentId], entities: { order: order.id, salesChannel: order.salesChannelId },
                }, options);
                dialog.destroy(); notify('Beleg per E-Mail versendet.'); onSent();
            } catch (error) { if (!dialog.destroyed && api.user) form.down('#error').update(encode(error.message)); }
            finally { sending = false; if (!dialog.destroyed) dialog.setLoading(false); }
        } }], listeners: { beforeclose: () => !sending },
    }); dialog.show();
}

function documents(api, config, order) {
    const orderId = order.id;
    const panel = entityListView(api, config, {
        title: 'Belege', singular: 'Beleg', entity: 'document', create: false, delete: false,
        search: ['documentNumber'], filter: [{ type: 'equals', field: 'orderId', value: orderId }], sort: 'createdAt', direction: 'DESC', fields: [],
        columns: [{ field: 'documentNumber', label: 'Belegnummer' }, { field: 'createdAt', label: 'Erstellt', type: 'date', width: 180 }, { field: 'sent', label: 'Versandt', type: 'boolean', width: 110 }],
        editor: (api, config, definition, id) => downloadDocument(api, id),
    });
    panel.setTitle('Belege');
    panel.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'Beleg erstellen', disabled: !api.can('document:create') || !api.can('document_type:read'),
        handler: () => documentDialog(api, orderId, () => panel.refreshRecords()) },
        { text: 'XML herunterladen', handler: () => downloadDocument(api, panel.getSelection()[0]?.id, 'xml') },
        { text: 'Beleg per E-Mail senden', disabled: !api.can('api_send_email') || !api.can('mail_template:read'), handler: () => {
            const id = panel.getSelection()[0]?.id; if (!id) { notify('Bitte einen Beleg auswählen.'); return; }
            sendDocument(api, order, id, () => panel.refreshRecords());
        } }] });
    return panel;
}

async function downloadDocument(api, id, requestedType) {
    if (!id) return;
    try {
        const document = (await api.search('document', { ids: [id], limit: 1, associations: { documentType: {}, documentMediaFile: {} } })).data[0];
        if (!document) throw new Error('Der Beleg ist nicht mehr vorhanden.');
        const fileType = requestedType || document.documentMediaFile?.fileExtension || documentFormat(document.documentType?.technicalName);
        const blob = await api.request(`/_action/document/${id}/${encodeURIComponent(document.deepLinkCode)}?download=true&fileType=${encodeURIComponent(fileType)}`, 'GET', undefined, { responseType: 'blob' });
        const url = URL.createObjectURL(blob);
        const link = window.document.createElement('a');
        link.href = url;
        link.download = `${document.documentNumber || id}.${fileType}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (api.user) showError(error); }
}

async function documentDialog(api, orderId, onCreated) {
    let types;
    try { types = (await api.search('document-type', { limit: 100, sort: [{ field: 'name', order: 'ASC' }] })).data; }
    catch (error) { if (api.user) showError(error); return; }
    const reference = entityField(api, { name: 'referencedDocumentId', label: 'Referenzbeleg (für Storno/Gutschrift)', type: 'reference',
        reference: { entity: 'document', labelFields: ['documentNumber'], filter: [{ type: 'equals', field: 'orderId', value: orderId }] } }, null, true);
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, defaults: { labelAlign: 'top', anchor: '100%' }, items: [
        { xtype: 'combobox', name: 'type', fieldLabel: 'Belegtyp', queryMode: 'local', editable: false, allowBlank: false, value: 'invoice',
            store: types.map(type => [type.technicalName, type.translated?.name || type.name || type.technicalName]) },
        { xtype: 'datefield', name: 'date', fieldLabel: 'Belegdatum', format: 'd.m.Y', value: new Date(), allowBlank: false },
        reference, { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
    ] });
    let saving = false;
    const dialog = Ext.create('Ext.window.Window', { title: 'Beleg erstellen', modal: true, width: Math.min(600, window.innerWidth - 24), layout: 'fit', items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Beleg erstellen', cls: 'emz-admin__primary', handler: async () => {
            if (saving || !form.getForm().isValid()) return;
            saving = true;
            dialog.setLoading('Beleg wird erstellt …');
            try {
                const values = form.getForm().getFieldValues();
                if (['storno', 'credit_note', 'zugferd_cancellation_invoice', 'zugferd_credit_note', 'zugferd_embedded_cancellation_invoice', 'zugferd_embedded_credit_note'].includes(values.type) && !values.referencedDocumentId) throw new Error('Bitte den zugehörigen Referenzbeleg auswählen.');
                const result = await api.request(`/_action/order/document/${encodeURIComponent(values.type)}/create`, 'POST', [{ orderId, fileType: documentFormat(values.type), static: false,
                    config: { documentDate: Ext.Date.format(values.date, 'Y-m-d') }, ...(values.referencedDocumentId ? { referencedDocumentId: values.referencedDocumentId } : {}) }]);
                if (Object.keys(result.errors || {}).length) throw new Error(Object.values(result.errors).map(error => error.detail || error.message || 'Beleg konnte nicht erstellt werden.').join('\n'));
                dialog.destroy(); notify('Beleg erstellt.'); onCreated();
            } catch (error) { if (!dialog.destroyed && api.user) form.down('#error').update(encode(error.message)); }
            finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
        } }], listeners: { beforeclose: () => !saving },
    });
    dialog.show();
}
