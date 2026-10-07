import { entityListView } from '../entity-list.js';
import { currencyPricesPanel } from '../product-prices.js';
import { replaceCurrencyPrice } from '../price-data.js';

const calculationOptions = [[1, 'Anzahl'], [2, 'Warenkorbwert'], [3, 'Gewicht (kg)'], [4, 'Volumen (mm³)'], [null, 'Regel']];

export function shippingPricesTabs(api, config, shipping) {
    if (!api.can('shipping_method_price:read')) return [];
    const definition = { title: 'Versandpreise', singular: 'Versandpreis', entity: 'shipping_method_price', sort: 'quantityStart', direction: 'ASC', search: [],
        filter: [{ type: 'equals', field: 'shippingMethodId', value: shipping.id }], defaults: { shippingMethodId: shipping.id }, associations: { rule: {}, calculationRule: {} },
        columns: [{ field: 'rule.name', label: 'Einschränkung', render: value => value || 'Alle Warenkörbe' },
            { field: 'calculation', label: 'Berechnung', render: value => calculationOptions.find(option => option[0] === value)?.[1] || 'Regel' },
            { field: 'quantityStart', label: 'Von', width: 90 }, { field: 'quantityEnd', label: 'Bis', width: 90 },
            { field: 'currencyPrice', label: `Brutto (${config.currencyCode})`, render: prices => prices?.find(price => price.currencyId === config.currencyId)?.gross ?? '—' }],
        fields: [
            { name: 'ruleId', label: 'Einschränkung (leer = alle Warenkörbe)', type: 'reference', reference: { entity: 'rule' } },
            { name: 'calculation', label: 'Berechnungsgrundlage', type: 'select', default: 2, options: calculationOptions },
            { name: 'calculationRuleId', label: 'Berechnungsregel (bei Grundlage Regel)', type: 'reference', reference: { entity: 'rule' } },
            { name: 'quantityStart', label: 'Von', type: 'number', min: 0, default: 0 }, { name: 'quantityEnd', label: 'Bis (leer = unbegrenzt)', type: 'number', min: 0 },
            { name: 'gross', label: `Versandpreis brutto (${config.currencyCode})`, type: 'number', required: true, min: 0,
                initialValue: record => record.currencyPrice?.find(price => price.currencyId === config.currencyId)?.gross },
            { name: 'net', label: `Versandpreis netto (${config.currencyCode})`, type: 'number', required: true, min: 0,
                initialValue: record => record.currencyPrice?.find(price => price.currencyId === config.currencyId)?.net },
        ],
        prepare: async (payload, original, { values }) => {
            if (values.calculation === null && !values.calculationRuleId) throw new Error('Bitte eine Berechnungsregel auswählen.');
            if (values.quantityEnd !== null && values.quantityStart !== null && values.quantityEnd < values.quantityStart) throw new Error('Der Endwert darf nicht kleiner als der Startwert sein.');
            if (values.calculation !== null && (!original || 'calculation' in payload || 'calculationRuleId' in payload)) payload.calculationRuleId = null;
            if (!original || 'gross' in payload || 'net' in payload) {
                const current = original ? (await api.search('shipping-method-price', { ids: [original.id], limit: 1 })).data[0] : null;
                const old = current?.currencyPrice?.find(price => price.currencyId === config.currencyId);
                payload.currencyPrice = replaceCurrencyPrice(current?.currencyPrice, { ...old, currencyId: config.currencyId, gross: values.gross, net: values.net, linked: false });
            }
            delete payload.gross; delete payload.net; return payload;
        },
        detailTabs: (api, config, record) => api.can('currency:read') ? [currencyPricesPanel(api, config, 'shipping_method_price', record.id, undefined, 'Währungspreise', 'currencyPrice')] : [],
    };
    const panel = entityListView(api, config, definition); panel.setTitle('Versandpreise'); return [panel];
}
