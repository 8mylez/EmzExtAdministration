import { entityListView } from '../entity-list.js';
import { encode, money, notify, showError } from '../ui.js';

export function orderRefunds(api, config, order) {
    let processing = false;
    const format = amount => order.currency?.isoCode ? money(amount, order.currency.isoCode) : String(amount);
    const refunds = entityListView(api, config, {
        title: 'Erstattungen', singular: 'Erstattung', entity: 'order_transaction_capture_refund', create: false, delete: false,
        filter: [{ type: 'equals', field: 'transactionCapture.transaction.orderId', value: order.id }], search: ['reason', 'externalReference'], sort: 'createdAt', direction: 'DESC',
        associations: { stateMachineState: {} },
        columns: [{ field: 'amount.totalPrice', label: 'Betrag', render: format }, { field: 'reason', label: 'Grund' },
            { field: 'stateMachineState.name', label: 'Status' }, { field: 'externalReference', label: 'Anbieter-Referenz' }],
        fields: [{ name: 'reason', label: 'Grund', readOnly: true }, { name: 'amount.totalPrice', label: 'Betrag', type: 'number', readOnly: true },
            { name: 'externalReference', label: 'Anbieter-Referenz', readOnly: true }],
        detailTabs: (api, config, refund) => api.can('order_transaction_capture_refund_position:read') ? [entityListView(api, config, {
            title: 'Erstattete Positionen', singular: 'Erstattungsposition', entity: 'order_transaction_capture_refund_position', create: false, delete: false,
            filter: [{ type: 'equals', field: 'refundId', value: refund.id }], search: [], sort: 'createdAt', associations: { orderLineItem: {} },
            columns: [{ field: 'orderLineItem.label', label: 'Position' }, { field: 'quantity', label: 'Menge' }, { field: 'amount.totalPrice', label: 'Betrag', render: format }, { field: 'reason', label: 'Grund' }],
            fields: [{ name: 'reason', label: 'Grund', readOnly: true }],
        })] : [],
    }); refunds.setTitle('Erstattungen');
    refunds.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'Erstattung ausführen', disabled: !api.can('order_refund.editor'), handler: execute },
        { xtype: 'tbtext', text: 'Erstattungsaufträge werden von der Zahlungs-Erweiterung bereitgestellt.' }] });
    function execute() {
        const refund = refunds.getSelection()[0]?.get('raw');
        if (!refund || processing) { if (!refund) notify('Bitte einen Erstattungsauftrag auswählen.'); return; }
        if (refund.stateMachineState?.technicalName !== 'open') { showError(new Error('Nur offene Erstattungsaufträge können ausgeführt werden.')); return; }
        Ext.Msg.confirm('Zahlung erstatten?', `${encode(format(refund.amount.totalPrice))} über den Zahlungsanbieter erstatten? ${encode(refund.reason || '')}`, async answer => {
            if (answer !== 'yes' || processing || refunds.destroyed) return;
            processing = true; refunds.setLoading('Erstattung wird verarbeitet …');
            try {
                const current = (await api.search('order-transaction-capture-refund', { ids: [refund.id], limit: 1, associations: { stateMachineState: {} } })).data[0];
                if (!current || current.stateMachineState?.technicalName !== 'open' || current.amount.totalPrice !== refund.amount.totalPrice) throw new Error('Der Erstattungsauftrag wurde geändert. Bitte erneut prüfen.');
                await api.request(`/_action/order_transaction_capture_refund/${refund.id}`, 'POST', {});
                notify('Der Zahlungsanbieter hat den Erstattungsauftrag verarbeitet. Der aktuelle Status steht in der Liste.');
            } catch (error) { if (api.user) showError(error); }
            finally { processing = false; if (!refunds.destroyed) { refunds.setLoading(false); refunds.refreshRecords(); } }
        });
    }
    return refunds;
}
