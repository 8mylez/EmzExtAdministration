import { promotionTabs, discountDefinition } from './promotions.js';
import { relationPanel } from '../relation-panel.js';
import { streamTabs } from './product-streams.js';
import { cmsAssignmentPanel } from './cms-assignment.js';
import { categoriesView, validateCategoryParent, writeCategory } from './categories.js';
import { validateLink } from './cms-config.js';
import { seoUrlsPanel } from './seo.js';
const field = (name, label, options = {}) => ({ name, label, ...options });
const ref = (name, label, entity, options = {}) => field(name, label, { type: 'reference', reference: { entity }, ...options });
const col = (field, label, options = {}) => ({ field, label, ...options });
const translatedValue = (record, name) => record[name] ?? record.translated?.[name];
const linkField = (name, label, options = {}) => field(name, label, { group: 'Verlinkung', translationValue: record => translatedValue(record, name), ...options });
const module = (id, title, singular, entity, fields, columns, options = {}) => ({
    id, title, singular, entity, group: 'Kataloge', icon: 'emz-admin__icon-products',
    search: ['name'], sort: 'name', direction: 'ASC', fields, columns: columns || [col('name', 'Name')], ...options,
});

export const catalogModules = [
    module('manufacturers', 'Hersteller', 'Hersteller', 'product_manufacturer', [
        field('name', 'Name', { required: true, maxLength: 255 }), field('link', 'Website'),
        ref('mediaId', 'Logo', 'media', { reference: { entity: 'media', labelFields: ['fileName'] } }),
        field('description', 'Beschreibung (HTML)', { type: 'textarea', height: 200 }),
    ], [col('name', 'Hersteller'), col('link', 'Website'), col('updatedAt', 'Geändert', { type: 'date', width: 180 })]),
    module('categories', 'Kategorien', 'Kategorie', 'category', [
        field('name', 'Name', { required: true }), ref('parentId', 'Übergeordnete Kategorie', 'category'),
        field('type', 'Typ', { type: 'select', required: true, default: 'page', options: [['page', 'Seite'], ['folder', 'Strukturelement'], ['link', 'Link']] }),
        field('active', 'Aktiv', { type: 'boolean', default: true }), field('visible', 'In der Navigation sichtbar', { type: 'boolean', default: true }),
        field('displayNestedProducts', 'Produkte aus Unterkategorien anzeigen', { type: 'boolean', default: true }),
        field('description', 'Beschreibung (HTML)', { type: 'textarea', group: 'Inhalte' }),
        ref('mediaId', 'Kategoriebild', 'media', { reference: { entity: 'media', labelFields: ['fileName'] }, group: 'Inhalte' }),
        ref('cmsPageId', 'Erlebniswelt', 'cms_page', { group: 'Inhalte' }),
        field('productAssignmentType', 'Produktzuweisung', { type: 'select', required: true, default: 'product', options: [['product', 'Manuell'], ['product_stream', 'Dynamische Produktgruppe']], group: 'Produkte' }),
        ref('productStreamId', 'Dynamische Produktgruppe', 'product_stream', { group: 'Produkte' }),
        linkField('linkType', 'Linkziel', { type: 'select', default: 'external', options: [['external', 'Externe URL'], ['category', 'Kategorie'], ['product', 'Produkt'], ['landing_page', 'Landingpage']] }),
        ...[['category', 'Kategorie'], ['product', 'Produkt'], ['landing_page', 'Landingpage']].map(([entity, label]) => ref(`linkTarget_${entity}`, `${label} als Linkziel`, entity, {
            group: 'Verlinkung', translationSource: 'internalLink', initialValue: record => record.linkType === entity ? record.internalLink : null,
            translationValue: record => translatedValue(record, 'linkType') === entity ? translatedValue(record, 'internalLink') : null,
        })),
        linkField('externalLink', 'Externer Link'), linkField('linkNewTab', 'In neuem Tab öffnen', { type: 'boolean' }),
        field('metaTitle', 'Meta-Titel', { group: 'SEO' }), field('metaDescription', 'Meta-Beschreibung', { type: 'textarea', group: 'SEO' }),
        field('keywords', 'Schlüsselwörter', { group: 'SEO' }),
    ], [col('name', 'Kategorie'), col('type', 'Typ', { width: 140 }), col('active', 'Aktiv', { type: 'boolean', width: 100 }), col('visible', 'Navigation', { type: 'boolean', width: 120 })], {
        activeFilter: true,
        view: (api, config) => categoriesView(api, config, catalogModules.find(module => module.id === 'categories')),
        groupTabs: true,
        write: writeCategory,
        prepareTranslation: (payload, original, { values }) => prepareCategoryLink(payload, original, { ...values, type: original.type }),
        detailTabs: (api, config, record) => [
            ...(api.can('seo_url:read') ? [seoUrlsPanel(api, config, { entity: 'category', id: record.id })] : []),
            ...(['cms_page:read', 'cms_slot:read'].every(privilege => api.can(privilege)) ? [cmsAssignmentPanel(api, config, { entity: 'category', id: record.id })] : []),
            ...(api.can('product:read') && record.productAssignmentType === 'product' ? [relationPanel(api, config, { entity: 'category', id: record.id }, { title: 'Produkte', entity: 'product', association: 'products', mapping: 'product_category', reverse: 'categories', labelFields: ['productNumber', 'name'], filter: [{ type: 'equals', field: 'parentId', value: null }] })] : []),
        ],
        prepare: async (payload, original, { api, values }) => {
            if (payload.parentId) await validateCategoryParent(api, original?.id, payload.parentId);
            if (values.productAssignmentType === 'product_stream' && !values.productStreamId) throw new Error('Bitte die dynamische Produktgruppe auswählen.');
            return prepareCategoryLink(payload, original, values);
        },
    }),
    module('properties', 'Eigenschaften', 'Eigenschaft', 'property_group', [
        field('name', 'Name', { required: true }), field('description', 'Beschreibung', { type: 'textarea' }),
        field('displayType', 'Darstellung', { required: true, type: 'select', default: 'text', options: [['text', 'Text'], ['color', 'Farbe'], ['media', 'Bild']] }),
        field('sortingType', 'Sortierung', { required: true, type: 'select', default: 'alphanumeric', options: [['alphanumeric', 'Alphanumerisch'], ['numeric', 'Numerisch'], ['position', 'Position']] }),
        field('filterable', 'Als Filter anzeigen', { type: 'boolean', default: true }),
        field('visibleOnProductDetailPage', 'Auf Produktdetailseite anzeigen', { type: 'boolean', default: true }),
        field('position', 'Position', { type: 'integer', default: 1 }),
    ], [col('name', 'Eigenschaft'), col('displayType', 'Darstellung'), col('filterable', 'Filter', { type: 'boolean', width: 110 })]),
    module('property-options', 'Eigenschaftsausprägungen', 'Ausprägung', 'property_group_option', [
        ref('groupId', 'Eigenschaft', 'property_group', { required: true }), field('name', 'Name', { required: true }),
        field('position', 'Position', { type: 'integer', default: 1 }), field('colorHexCode', 'Farbwert (z. B. #ff0000)'),
        ref('mediaId', 'Bild', 'media', { reference: { entity: 'media', labelFields: ['fileName'] } }),
    ], [col('name', 'Ausprägung'), col('colorHexCode', 'Farbe'), col('position', 'Position', { width: 110 })]),
    module('tags', 'Tags', 'Tag', 'tag', [field('name', 'Name', { required: true })]),
    module('reviews', 'Bewertungen', 'Bewertung', 'product_review', [
        field('title', 'Titel', { readOnly: true }), field('content', 'Kundenbewertung', { type: 'textarea', readOnly: true, height: 180 }),
        field('points', 'Bewertung', { type: 'number', readOnly: true }), field('status', 'Veröffentlicht', { type: 'boolean' }),
        field('comment', 'Antwort', { type: 'textarea', height: 180 }),
    ], [col('title', 'Titel'), col('externalUser', 'Name'), col('points', 'Punkte', { width: 100 }), col('status', 'Veröffentlicht', { type: 'boolean', width: 130 }), col('createdAt', 'Datum', { type: 'date', width: 180 })], {
        create: false, search: ['title', 'content', 'externalUser'], sort: 'createdAt', direction: 'DESC', labelFields: ['title'],
    }),
    module('product-streams', 'Dynamische Produktgruppen', 'Produktgruppe', 'product_stream', [
        field('name', 'Name', { required: true }), field('description', 'Beschreibung', { type: 'textarea' }),
        field('displayAsGroup', 'Als Gruppe anzeigen', { type: 'boolean' }),
    ], undefined, { detailTabs: streamTabs }),
    module('landing-pages', 'Landingpages', 'Landingpage', 'landing_page', [
        field('name', 'Name', { required: true }), field('url', 'URL-Pfad', { required: true }), field('active', 'Aktiv', { type: 'boolean' }),
        ref('initialSalesChannelIds', 'Verkaufskanäle', 'sales_channel', { multiple: true, required: true, createOnly: true }),
        ref('cmsPageId', 'Erlebniswelt', 'cms_page'), field('metaTitle', 'Meta-Titel', { group: 'SEO' }),
        field('metaDescription', 'Meta-Beschreibung', { type: 'textarea', group: 'SEO' }), field('keywords', 'Schlüsselwörter', { group: 'SEO' }),
    ], [col('name', 'Name'), col('url', 'URL-Pfad'), col('active', 'Aktiv', { type: 'boolean', width: 100 })], { group: 'Inhalte', activeFilter: true,
        prepare: (payload, original) => {
            if (!original) { payload.salesChannels = (payload.initialSalesChannelIds || []).map(id => ({ id })); delete payload.initialSalesChannelIds; }
            return payload;
        }, detailTabs: (api, config, record) => [
        ...(api.can('seo_url:read') ? [seoUrlsPanel(api, config, { entity: 'landing_page', id: record.id })] : []),
        ...[['Verkaufskanäle', 'sales_channel', 'salesChannels', 'landing_page_sales_channel'], ['Tags', 'tag', 'tags', 'landing_page_tag']]
            .filter(([, entity]) => api.can(`${entity}:read`)).map(([title, entity, association, mapping]) => relationPanel(api, config, { entity: 'landing_page', id: record.id }, { title, entity, association, mapping, reverse: 'landingPages' })),
        ...(['cms_page:read', 'cms_slot:read'].every(privilege => api.can(privilege)) ? [cmsAssignmentPanel(api, config, { entity: 'landing_page', id: record.id })] : []),
    ] }),
];

function prepareCategoryLink(payload, original, values) {
    const changed = !original || ['type', 'linkType', 'externalLink', `linkTarget_${values.linkType}`].some(key => key in payload);
    if (values.type === 'link' && changed) {
        if (values.linkType === 'external') {
            if (!values.externalLink?.trim()) throw new Error('Bitte eine externe URL eingeben.');
            validateLink(values.externalLink);
            Object.assign(payload, { externalLink: values.externalLink.trim(), internalLink: null, linkType: 'external' });
        } else {
            const id = values[`linkTarget_${values.linkType}`];
            if (!id) throw new Error('Bitte das passende interne Linkziel auswählen.');
            Object.assign(payload, { linkType: values.linkType, internalLink: id, externalLink: null });
        }
    }
    for (const key of Object.keys(payload).filter(key => key.startsWith('linkTarget_'))) delete payload[key];
    return payload;
}

export const marketingModules = [
    module('promotions', 'Rabatte & Aktionen', 'Aktion', 'promotion', [
        field('name', 'Name', { required: true }), field('active', 'Aktiv', { type: 'boolean' }),
        field('validFrom', 'Gültig ab', { type: 'datetime' }), field('validUntil', 'Gültig bis', { type: 'datetime' }),
        field('priority', 'Priorität', { type: 'integer', required: true, default: 1 }),
        field('maxRedemptionsGlobal', 'Maximale Einlösungen gesamt', { type: 'integer', min: 0 }),
        field('maxRedemptionsPerCustomer', 'Maximale Einlösungen pro Kunde', { type: 'integer', min: 0 }),
        field('useSetGroups', 'Set-Gruppen verwenden', { type: 'boolean' }), field('customerRestriction', 'Auf Kundenauswahl beschränken', { type: 'boolean' }),
        ref('exclusionIds', 'Nicht kombinierbare Aktionen', 'promotion', { multiple: true }),
        field('exclusive', 'Exklusiv', { type: 'boolean' }), field('preventCombination', 'Kombination verhindern', { type: 'boolean' }),
        field('useCodes', 'Aktionscode verwenden', { type: 'boolean', group: 'Aktionscodes' }), field('code', 'Aktionscode', { group: 'Aktionscodes' }),
        field('useIndividualCodes', 'Individuelle Codes verwenden', { type: 'boolean', group: 'Aktionscodes' }),
        field('individualCodePattern', 'Muster individueller Codes', { group: 'Aktionscodes' }),
    ], [col('name', 'Aktion'), col('code', 'Aktionscode'), col('active', 'Aktiv', { type: 'boolean', width: 100 }), col('validUntil', 'Gültig bis', { type: 'date', width: 180 })], {
        group: 'Marketing', activeFilter: true, detailTabs: promotionTabs, defaults: { useSetGroups: false, customerRestriction: false },
        prepare: (payload, original) => {
            const from = payload.validFrom === undefined ? original?.validFrom : payload.validFrom;
            const until = payload.validUntil === undefined ? original?.validUntil : payload.validUntil;
            if (from && until && new Date(from) > new Date(until)) throw new Error('Das Enddatum muss nach dem Startdatum liegen.');
            return payload;
        },
    }),
    discountDefinition,
    module('newsletter', 'Newsletter-Empfänger', 'Newsletter-Empfänger', 'newsletter_recipient', [
        field('email', 'E-Mail', { type: 'email', required: true }), field('firstName', 'Vorname'), field('lastName', 'Nachname'),
        field('status', 'Status', { readOnly: true }), field('city', 'Ort'), field('zipCode', 'Postleitzahl'), field('street', 'Straße'),
    ], [col('email', 'E-Mail'), col('firstName', 'Vorname'), col('lastName', 'Nachname'), col('status', 'Status', { width: 150 })], {
        group: 'Marketing', create: false, search: ['email', 'firstName', 'lastName'], sort: 'email', labelFields: ['email'],
    }),
];
