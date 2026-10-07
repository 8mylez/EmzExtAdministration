import { channelThemePanel } from './themes.js';
import { channelProductExports } from './product-exports.js';
import { channelMeasurementPanel } from './measurement.js';
import { relationPanel } from '../relation-panel.js';
import { entityListView } from '../entity-list.js';
import { cmsAssignmentPanel } from './cms-assignment.js';
const field = (name, label, options = {}) => ({ name, label, ...options });
const ref = (name, label, entity, options = {}) => field(name, label, { type: 'reference', reference: { entity }, ...options });
export const channelModules = [{
    id: 'sales-channels', title: 'Verkaufskanäle', singular: 'Verkaufskanal', entity: 'sales_channel', group: 'Verkaufskanäle', icon: 'x-fa fa-store',
    search: ['name'], sort: 'name', direction: 'ASC', activeFilter: true,
    columns: [{ field: 'name', label: 'Verkaufskanal' }, { field: 'active', label: 'Aktiv', type: 'boolean', width: 100 }, { field: 'maintenance', label: 'Wartungsmodus', type: 'boolean', width: 140 }],
    defaults: { taxCalculationType: 'horizontal', homeEnabled: false },
    fields: [
        field('name', 'Name', { required: true }), ref('typeId', 'Typ', 'sales_channel_type', { required: true, createOnly: true }),
        field('active', 'Aktiv', { type: 'boolean' }), field('maintenance', 'Wartungsmodus', { type: 'boolean' }),
        field('maintenanceIpWhitelist', 'Wartungsmodus: erlaubte IP-Adressen (eine je Zeile)', { type: 'lines' }),
        field('taxCalculationType', 'Steuerberechnung', { type: 'select', default: 'horizontal', options: [['horizontal', 'Horizontal (je Position)'], ['vertical', 'Vertikal (Gesamtsumme)']] }),
        field('hreflangActive', 'Hreflang aktiv', { type: 'boolean' }),
        ref('languageId', 'Standardsprache', 'language', { required: true }), ref('currencyId', 'Standardwährung', 'currency', { required: true }),
        ref('customerGroupId', 'Kundengruppe', 'customer_group', { required: true }), ref('countryId', 'Standardland', 'country', { required: true }),
        ref('paymentMethodId', 'Standard-Zahlungsart', 'payment_method', { required: true }), ref('shippingMethodId', 'Standard-Versandart', 'shipping_method', { required: true }),
        ref('navigationCategoryId', 'Hauptnavigation', 'category', { required: true, group: 'Navigation' }),
        field('navigationCategoryDepth', 'Navigationstiefe', { type: 'integer', min: 1, default: 2, group: 'Navigation' }),
        ref('footerCategoryId', 'Footer-Navigation', 'category', { group: 'Navigation' }), ref('serviceCategoryId', 'Service-Navigation', 'category', { group: 'Navigation' }),
        ref('mailHeaderFooterId', 'E-Mail-Layout', 'mail_header_footer'),
        field('homeEnabled', 'Eigene Startseite aktiv', { type: 'boolean', group: 'Startseite' }), ref('homeCmsPageId', 'Startseiten-Erlebniswelt', 'cms_page', { group: 'Startseite' }),
        field('homeName', 'Startseitentitel', { group: 'Startseite' }), field('homeMetaTitle', 'Meta-Titel', { group: 'Startseite' }),
        field('homeMetaDescription', 'Meta-Beschreibung', { type: 'textarea', group: 'Startseite' }),
    ],
    detailTabs: (api, config, channel) => {
        const owner = { entity: 'sales_channel', id: channel.id };
        const relations = [
            ['Sprachen', 'language', 'languages', 'sales_channel_language', 'languageId'],
            ['Währungen', 'currency', 'currencies', 'sales_channel_currency', 'currencyId'],
            ['Länder', 'country', 'countries', 'sales_channel_country', 'countryId'],
            ['Zahlungsarten', 'payment_method', 'paymentMethods', 'sales_channel_payment_method', 'paymentMethodId'],
            ['Versandarten', 'shipping_method', 'shippingMethods', 'sales_channel_shipping_method', 'shippingMethodId'],
        ];
        const tabs = relations.filter(([, entity]) => api.can(`${entity}:read`)).map(([title, entity, association, mapping, defaultField]) =>
            relationPanel(api, config, owner, { title, entity, association, mapping, defaultField, reverse: 'salesChannels' }));
        if (api.can('sales_channel_domain:read')) {
            const definition = channelModules[1];
            const panel = entityListView(api, config, { ...definition, filter: [{ type: 'equals', field: 'salesChannelId', value: channel.id }],
                defaults: { salesChannelId: channel.id }, fields: definition.fields.filter(field => field.name !== 'salesChannelId') });
            panel.setTitle('Domains'); tabs.push(panel);
        }
        if (api.can('theme:read')) tabs.push(channelThemePanel(api, channel));
        if (['cms_page:read', 'cms_slot:read'].every(privilege => api.can(privilege))) tabs.push(cmsAssignmentPanel(api, config, { ...owner, field: 'homeSlotConfig', pageField: 'homeCmsPageId' }));
        if (api.can('product_export:read') && channel.typeId === config.productExportTypeId) tabs.push(channelProductExports(api, config, channel));
        if (api.can('measurement_system:read') && api.can('measurement_display_unit:read')) tabs.push(channelMeasurementPanel(api, owner));
        return tabs;
    },
    prepare: async (payload, original, { api }) => {
        if (!original) payload.accessKey = (await api.request('/_action/access-key/sales-channel')).accessKey;
        // Selecting a default also makes that value available in the sales channel.
        for (const [field, association] of [['languageId', 'languages'], ['currencyId', 'currencies'], ['countryId', 'countries'], ['paymentMethodId', 'paymentMethods'], ['shippingMethodId', 'shippingMethods']]) {
            if (payload[field]) payload[association] = [{ id: payload[field] }];
        }
        return payload;
    },
}, {
    id: 'sales-channel-domains', title: 'Verkaufskanal-Domains', singular: 'Domain', entity: 'sales_channel_domain', group: 'Verkaufskanäle', icon: 'x-fa fa-globe',
    search: ['url'], sort: 'url', direction: 'ASC', labelFields: ['url'],
    columns: [{ field: 'url', label: 'Domain' }, { field: 'isExternalStorefront', label: 'Externes Frontend', type: 'boolean', width: 160 }],
    fields: [
        field('url', 'URL mit https://', { required: true }), ref('salesChannelId', 'Verkaufskanal', 'sales_channel', { required: true }),
        ref('languageId', 'Sprache', 'language', { required: true }), ref('currencyId', 'Währung', 'currency', { required: true }),
        ref('snippetSetId', 'Textbaustein-Set', 'snippet_set', { required: true }), field('hreflangUseOnlyLocale', 'Hreflang nur mit Sprache', { type: 'boolean' }),
        field('isExternalStorefront', 'Externes Frontend', { type: 'boolean' }),
    ],
    prepare: payload => {
        if (payload.url && !/^https?:\/\//i.test(payload.url)) throw new Error('Die Domain muss mit http:// oder https:// beginnen.');
        return payload;
    },
    detailTabs: (api, config, domain) => api.can('measurement_system:read') && api.can('measurement_display_unit:read')
        ? [channelMeasurementPanel(api, { entity: 'sales_channel_domain', id: domain.id })] : [],
}];
