import { entityListView } from '../entity-list.js';
import { openEntityEditor } from '../entity-editor.js';
import { relationPanel } from '../relation-panel.js';
import { encode, notify, showError } from '../ui.js';

const field = (name, label, options = {}) => ({ name, label, ...options });
const ref = (name, label, entity, options = {}) => field(name, label, { type: 'reference', reference: { entity }, ...options });
const sorters = [['PRICE_ASC', 'Preis aufsteigend'], ['PRICE_DESC', 'Preis absteigend']];

export const discountDefinition = {
    id: 'promotion-discounts', title: 'Aktionsrabatte', singular: 'Aktionsrabatt', entity: 'promotion_discount', group: 'Marketing', icon: 'x-fa fa-percent',
    search: [], sort: 'createdAt', labelFields: ['type', 'value'], defaults: { sorterKey: 'PRICE_ASC', applierKey: 'ALL', usageKey: 'ALL' },
    columns: [{ field: 'scope', label: 'Geltungsbereich' }, { field: 'type', label: 'Art' }, { field: 'value', label: 'Wert' }, { field: 'maxValue', label: 'Maximaler Rabatt' }],
    fields: [ref('promotionId', 'Aktion', 'promotion', { required: true }),
        field('scope', 'Geltungsbereich', { type: 'select', required: true, default: 'cart', options: [['cart', 'Warenkorb'], ['delivery', 'Versand'], ['set', 'Set']] }),
        field('type', 'Rabattart', { type: 'select', required: true, default: 'percentage', options: [['percentage', 'Prozentual'], ['absolute', 'Absoluter Rabatt'], ['fixed', 'Festpreis gesamt'], ['fixed_unit', 'Festpreis je Stück']] }),
        field('value', 'Wert', { type: 'number', required: true, min: 0 }), field('maxValue', 'Maximaler Rabatt', { type: 'number', min: 0 }),
        field('considerAdvancedRules', 'Erweiterte Regeln berücksichtigen', { type: 'boolean' }),
        field('sorterKey', 'Produkte sortieren', { type: 'select', default: 'PRICE_ASC', options: sorters }),
        field('applierKey', 'Anwendung (ALL oder jede n-te Position)', { default: 'ALL' }),
        field('usageKey', 'Häufigkeit (ALL oder Anzahl)', { default: 'ALL' }), field('pickerKey', 'Produktauswahl', { type: 'select', options: [['', 'Alle passenden Produkte']] }),
    ],
    editor: async (api, config, definition, id, onSaved) => {
        try {
            const original = id ? (await api.search('promotion-discount', { ids: [id], limit: 1 })).data[0] : null;
            const promotionId = definition.defaults?.promotionId || original?.promotionId;
            const [sorterKeys, pickerKeys, groups] = await Promise.all([
                api.request('/_action/promotion/setgroup/sorter'), api.request('/_action/promotion/discount/picker'),
                promotionId ? api.search('promotion-setgroup', { limit: 500, filter: [{ type: 'equals', field: 'promotionId', value: promotionId }], sort: [{ field: 'id', order: 'ASC' }] }) : Promise.resolve({ data: [] }),
            ]);
            const fields = definition.fields.map(item => {
                if (item.name === 'sorterKey') return { ...item, options: sorterKeys.map(key => [key, sorters.find(row => row[0] === key)?.[1] || key]) };
                if (item.name === 'pickerKey') return { ...item, options: [['', 'Alle passenden Produkte'], ...pickerKeys.map(key => [key, key])] };
                if (item.name === 'scope') return { ...item, options: [...item.options, ...groups.data.map((group, index) => [`setgroup-${index + 1}`, `Set-Gruppe ${index + 1}`])] };
                return item;
            });
            return openEntityEditor(api, config, { ...definition, fields }, id, onSaved);
        } catch (error) { if (api.user) showError(error); }
    },
    prepare: (payload, original) => {
        const discount = { ...original, ...payload };
        if (discount.type === 'percentage' && discount.value > 100) throw new Error('Ein prozentualer Rabatt darf höchstens 100 betragen.');
        if (discount.scope === 'delivery' && discount.type === 'fixed_unit') throw new Error('Versandrabatte unterstützen keinen Festpreis je Stück.');
        if (discount.scope === 'cart' && discount.type === 'fixed' && !discount.considerAdvancedRules) throw new Error('Ein Festpreis im Warenkorb benötigt erweiterte Regeln für die rabattierten Produkte.');
        for (const key of ['applierKey', 'usageKey']) if (discount[key] && discount[key] !== 'ALL' && !/^[1-9]\d*$/.test(discount[key])) throw new Error('Anwendung und Häufigkeit benötigen ALL oder eine positive ganze Zahl.');
        return payload;
    },
    detailTabs: (api, config, discount) => {
        const tabs = [];
        if (api.can('rule:read')) tabs.push(relationPanel(api, config, { entity: 'promotion_discount', id: discount.id },
            { title: 'Produktregeln', entity: 'rule', association: 'discountRules', mapping: 'promotion_discount_rule', reverse: 'promotionDiscounts' }));
        if (api.can('promotion_discount_prices:read')) {
            const panel = entityListView(api, config, { title: 'Währungsbeträge', singular: 'Währungsbetrag', entity: 'promotion_discount_prices', search: [], sort: 'createdAt',
                filter: [{ type: 'equals', field: 'discountId', value: discount.id }], defaults: { discountId: discount.id }, associations: { currency: {} },
                fields: [ref('currencyId', 'Währung', 'currency', { required: true }), field('price', discount.type === 'percentage' ? 'Maximaler Rabatt' : 'Betrag', { type: 'number', required: true, min: 0 })],
                columns: [{ field: 'currency.name', label: 'Währung' }, { field: 'price', label: 'Betrag' }],
            }); panel.setTitle('Währungsbeträge'); tabs.push(panel);
        }
        return tabs;
    },
};

export function promotionTabs(api, config, promotion) {
    const tabs = []; const owner = { entity: 'promotion', id: promotion.id };
    const relations = [
        ['Kundenregeln', 'rule', 'personaRules', 'personaPromotions', 'promotion_persona_rule'],
        ['Warenkorbregeln', 'rule', 'cartRules', 'cartPromotions', 'promotion_cart_rule'],
        ['Bestellregeln', 'rule', 'orderRules', 'orderPromotions', 'promotion_order_rule'],
        ['Kundenauswahl', 'customer', 'personaCustomers', 'promotions', 'promotion_persona_customer'],
    ];
    for (const [title, entity, association, reverse, mapping] of relations) if (api.can(`${entity}:read`)) tabs.push(relationPanel(api, config, owner,
        { title, entity, association, reverse, mapping, ...(entity === 'customer' ? { labelFields: ['email', 'firstName', 'lastName'] } : {}) }));
    const children = [{ title: 'Verkaufskanäle', singular: 'Kanalzuordnung', entity: 'promotion_sales_channel', search: ['salesChannel.name'], sort: 'priority', associations: { salesChannel: {} },
        fields: [ref('salesChannelId', 'Verkaufskanal', 'sales_channel', { required: true }), field('priority', 'Priorität', { type: 'integer', default: promotion.priority, required: true })],
        columns: [{ field: 'salesChannel.name', label: 'Verkaufskanal' }, { field: 'priority', label: 'Priorität', width: 110 }] },
    { ...discountDefinition, title: 'Rabatte', fields: discountDefinition.fields.filter(field => field.name !== 'promotionId') },
    { title: 'Set-Gruppen', singular: 'Set-Gruppe', entity: 'promotion_setgroup', search: [], sort: 'id', direction: 'ASC',
        fields: [field('packagerKey', 'Zusammenstellung', { type: 'select', required: true, options: [], default: 'COUNT' }), field('value', 'Anzahl / Wert', { type: 'number', min: 0.000001, required: true }),
            field('sorterKey', 'Sortierung', { type: 'select', required: true, options: sorters, default: 'PRICE_ASC' })],
        columns: [{ field: 'packagerKey', label: 'Zusammenstellung' }, { field: 'value', label: 'Anzahl / Wert' }, { field: 'sorterKey', label: 'Sortierung' }],
        editor: async (api, config, definition, id, onSaved) => {
            try {
                const [packagers, sorters] = await Promise.all([api.request('/_action/promotion/setgroup/packager'), api.request('/_action/promotion/setgroup/sorter')]);
                return openEntityEditor(api, config, { ...definition, fields: definition.fields.map(field => field.name === 'packagerKey' || field.name === 'sorterKey'
                    ? { ...field, options: (field.name === 'packagerKey' ? packagers : sorters).map(key => [key, key]) } : field) }, id, onSaved);
            } catch (error) { if (api.user) showError(error); }
        },
        detailTabs: (api, config, group) => api.can('rule:read') ? [relationPanel(api, config, { entity: 'promotion_setgroup', id: group.id },
            { title: 'Set-Regeln', entity: 'rule', association: 'setGroupRules', mapping: 'promotion_setgroup_rule', reverse: 'promotionSetGroups' })] : [],
    }];
    for (const definition of children) if (api.can(`${definition.entity}:read`)) {
        const panel = entityListView(api, config, { ...definition, filter: [{ type: 'equals', field: 'promotionId', value: promotion.id }], defaults: { ...definition.defaults, promotionId: promotion.id } });
        panel.setTitle(definition.title); tabs.push(panel);
    }
    if (api.can('promotion_individual_code:read')) tabs.push(codesPanel(api, config, promotion));
    return tabs;
}

function codesPanel(api, config, promotion) {
    const filter = [{ type: 'equals', field: 'promotionId', value: promotion.id }];
    const panel = entityListView(api, config, { title: 'Individuelle Codes', singular: 'Code', entity: 'promotion_individual_code', search: ['code'], sort: 'code', direction: 'ASC',
        filter, defaults: { promotionId: promotion.id }, isLocked: record => Boolean(record?.payload && Object.keys(record.payload).length), labelFields: ['code'],
        fields: [field('code', 'Code', { required: true })],
        columns: [{ field: 'code', label: 'Code' }, { field: 'payload', label: 'Eingelöst', render: value => value && Object.keys(value).length ? 'Ja' : 'Nein' }],
    }); panel.setTitle('Individuelle Codes');
    panel.addDocked({ xtype: 'toolbar', dock: 'top', items: [
        { text: 'Codes erzeugen', disabled: !api.can('promotion.editor') || !api.can('promotion_individual_code:create'), handler: generate },
        { text: 'Codes als CSV herunterladen', handler: async button => {
            button.disable();
            try {
                let page = 1; const rows = ['code;redeemed'];
                while (true) {
                    const response = await api.search('promotion-individual-code', { page, limit: 100, filter, sort: [{ field: 'code', order: 'ASC' }] });
                    response.data.forEach(code => rows.push(`"${String(code.code).replaceAll('"', '""')}";${code.payload && Object.keys(code.payload).length ? 1 : 0}`));
                    if (page * 100 >= response.total || !response.data.length) break; page++;
                }
                const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
                const link = document.createElement('a'); link.href = url; link.download = 'aktionscodes.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
            } catch (error) { if (api.user) showError(error); }
            finally { if (!button.destroyed) button.enable(); }
        } },
    ] });
    async function generate() {
        let current;
        try { current = (await api.search('promotion', { ids: [promotion.id], limit: 1 })).data[0]; }
        catch (error) { if (api.user) showError(error); return; }
        if (!current.individualCodePattern || !current.useIndividualCodes || !current.useCodes) { showError(new Error('Bitte zunächst Aktionscodes und individuelle Codes aktivieren sowie ein Muster speichern (z. B. SALE-%s%s%s%s%d%d).')); return; }
        let saving = false;
        const amount = Ext.create('Ext.form.field.Number', { fieldLabel: 'Anzahl neuer Codes', labelAlign: 'top', value: 100, minValue: 1, maxValue: 10000, allowDecimals: false, allowBlank: false });
        const dialog = Ext.create('Ext.window.Window', { title: 'Individuelle Codes erzeugen', modal: true, width: 540, bodyPadding: 20,
            items: [{ xtype: 'component', html: `<p>Muster: ${encode(current.individualCodePattern)}</p><p>Neue Codes werden ergänzt. Bestehende Codes bleiben gültig.</p>` }, amount],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Codes hinzufügen', cls: 'emz-admin__primary', handler: async () => {
                if (saving || !amount.isValid()) return; saving = true; dialog.setLoading('Codes werden erzeugt …');
                try { await api.request('/_action/promotion/codes/add-individual', 'POST', { promotionId: promotion.id, amount: amount.getValue() });
                    dialog.destroy(); if (!panel.destroyed) panel.refreshRecords(); notify('Individuelle Codes erzeugt.'); }
                catch (error) { if (api.user) showError(error); }
                finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
            } }], listeners: { beforeclose: () => !saving },
        }); dialog.show();
    }
    return panel;
}
