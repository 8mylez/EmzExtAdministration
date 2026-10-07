import { entityListView } from './entity-list.js';
import { notify, showError } from './ui.js';
import { openVariantGenerator } from './product-variants.js';
import { currencyPricesPanel, advancedPricesPanel } from './product-prices.js';
import { uploadDialog, openMedia } from './modules/media.js';
import { variantSettingsPanel } from './variant-settings.js';
import { cmsAssignmentPanel } from './modules/cms-assignment.js';
import { productAssociations, productAssociationPanel, inheritedProductChildren } from './product-associations.js';
import { openProductBulk } from './product-bulk.js';
import { seoUrlsPanel } from './modules/seo.js';

export const productDetailFields = [
    { name: 'type', label: 'Produkttyp (nach Anlage unveränderlich)', type: 'select', createOnly: true, default: 'physical', options: [['physical', 'Physisch'], ['digital', 'Digital']] },
    { name: 'manufacturerId', label: 'Hersteller', type: 'reference', reference: { entity: 'product_manufacturer' } },
    { name: 'manufacturerNumber', label: 'Herstellernummer' }, { name: 'ean', label: 'EAN / GTIN' },
    { name: 'featureSetId', label: 'Wesentliche Merkmale', type: 'reference', reference: { entity: 'product_feature_set' } },
    { name: 'cmsPageId', label: 'Produktlayout', type: 'reference', reference: { entity: 'cms_page', filter: [{ type: 'equals', field: 'type', value: 'product_detail' }] } },
    { name: 'markAsTopseller', label: 'Als Topseller hervorheben', type: 'boolean' },
    { name: 'guaranteeMonths', label: 'Haltbarkeitsgarantie (Monate)', type: 'integer', min: 0 },
    { name: 'guaranteeConfirmed', label: 'Angaben zur Haltbarkeitsgarantie bestätigt', type: 'boolean' },
    { name: 'isCloseout', label: 'Abverkauf', type: 'boolean' }, { name: 'shippingFree', label: 'Versandkostenfrei', type: 'boolean' },
    { name: 'minPurchase', label: 'Mindestabnahme', type: 'integer', default: 1, min: 1 },
    { name: 'purchaseSteps', label: 'Abnahmeschritte', type: 'integer', default: 1, min: 1 },
    { name: 'maxPurchase', label: 'Maximalabnahme', type: 'integer', min: 1 },
    { name: 'deliveryTimeId', label: 'Lieferzeit', type: 'reference', reference: { entity: 'delivery_time' } },
    { name: 'restockTime', label: 'Wiederbeschaffungszeit (Tage)', type: 'integer', min: 0 },
    { name: 'releaseDate', label: 'Erscheinungsdatum', type: 'date' },
    { name: 'weight', label: 'Gewicht (kg)', type: 'number', min: 0 },
    { name: 'width', label: 'Breite (mm)', type: 'number', min: 0 }, { name: 'height', label: 'Höhe (mm)', type: 'number', min: 0 }, { name: 'length', label: 'Länge (mm)', type: 'number', min: 0 },
    { name: 'unitId', label: 'Maßeinheit', type: 'reference', reference: { entity: 'unit' } },
    { name: 'purchaseUnit', label: 'Verkaufseinheit', type: 'number', min: 0 }, { name: 'referenceUnit', label: 'Grundeinheit', type: 'number', min: 0 },
    { name: 'packUnit', label: 'Verpackungseinheit' }, { name: 'packUnitPlural', label: 'Verpackungseinheit (Mehrzahl)' },
    { name: 'metaTitle', label: 'Meta-Titel' }, { name: 'metaDescription', label: 'Meta-Beschreibung', type: 'textarea' }, { name: 'keywords', label: 'Schlüsselwörter' },
    { name: 'customSearchKeywords', label: 'Zusätzliche Suchbegriffe (einer je Zeile)', type: 'lines' },
    { name: 'canonicalProductId', label: 'Kanonisches Produkt', type: 'reference', reference: { entity: 'product', labelFields: ['productNumber', 'name'] } },
    { name: 'openGraphMediaId', label: 'Vorschaubild für soziale Netzwerke', type: 'reference', reference: { entity: 'media', labelFields: ['fileName'] } },
    { name: 'ogTitle', label: 'Titel für soziale Netzwerke' }, { name: 'ogDescription', label: 'Beschreibung für soziale Netzwerke', type: 'textarea' },
];

export function productRelationTabs(api, config, product, editVariant, taxRate) {
    const productId = product.id;
    const tabs = [];
    if (['cms_page:read', 'cms_slot:read'].every(privilege => api.can(privilege))) tabs.push(cmsAssignmentPanel(api, config, { entity: 'product', id: productId }));
    if (api.can('seo_url:read')) tabs.push(seoUrlsPanel(api, config, { entity: 'product', id: productId }));
    if (api.can('currency:read') && api.can('tax:read')) {
        tabs.push(currencyPricesPanel(api, config, 'product', productId, taxRate));
        tabs.push(currencyPricesPanel(api, config, 'product', productId, taxRate, 'Einkaufspreise', 'purchasePrices'));
        if (api.can('product_price:read')) tabs.push(advancedPricesPanel(api, config, productId, taxRate, product));
    }
    for (const relation of productAssociations) {
        if (api.can(`${relation.entity}:read`)) tabs.push(productAssociationPanel(api, product, relation));
    }
    const children = [
        { title: 'SEO-Hauptkategorien', singular: 'Hauptkategorie', entity: 'main_category', associations: { category: {}, salesChannel: {} },
            fields: [{ name: 'salesChannelId', label: 'Verkaufskanal', type: 'reference', required: true, reference: { entity: 'sales_channel' } },
                { name: 'categoryId', label: 'Hauptkategorie', type: 'reference', required: true, reference: { entity: 'category' } }],
            columns: [{ field: 'salesChannel.name', label: 'Verkaufskanal' }, { field: 'category.name', label: 'Hauptkategorie' }] },
        { title: 'Verkaufskanäle', singular: 'Sichtbarkeit', entity: 'product_visibility',
            fields: [{ name: 'salesChannelId', label: 'Verkaufskanal', required: true, type: 'reference', reference: { entity: 'sales_channel' } },
                { name: 'visibility', label: 'Sichtbarkeit', required: true, type: 'select', default: 30, options: [[10, 'Direktlink'], [20, 'Suche'], [30, 'Überall']] }],
            columns: [{ field: 'salesChannelId', label: 'Verkaufskanal-ID' }, { field: 'visibility', label: 'Sichtbarkeit', render: value => ({ 10: 'Direktlink', 20: 'Suche', 30: 'Überall' })[value] }] },
        { title: 'Bilder', singular: 'Produktbild', entity: 'product_media',
            fields: [{ name: 'mediaId', label: 'Bild', required: true, type: 'reference', reference: { entity: 'media', labelFields: ['fileName'] } },
                { name: 'position', label: 'Position', type: 'integer', default: 1 }],
            columns: [{ field: 'mediaId', label: 'Medien-ID' }, { field: 'position', label: 'Position', width: 100 }] },
        { title: 'Downloads', singular: 'Download-Datei', entity: 'product_download', associations: { media: {} },
            fields: [{ name: 'mediaId', label: 'Private Datei', required: true, type: 'reference',
                reference: { entity: 'media', labelFields: ['fileName'], filter: [{ type: 'equals', field: 'private', value: true }] } },
                { name: 'position', label: 'Position', type: 'integer', min: 0, default: 1 }],
            columns: [{ field: 'media.fileName', label: 'Datei' }, { field: 'position', label: 'Position', width: 100 }],
            prepare: async payload => {
                if (payload.mediaId) {
                    const media = (await api.search('media', { ids: [payload.mediaId], limit: 1 })).data[0];
                    if (!media?.private) throw new Error('Download-Produkte benötigen eine private Datei.');
                }
                return payload;
            } },
        { title: 'Variantenoptionen', singular: 'Variantenoption', entity: 'product_configurator_setting',
            fields: [{ name: 'optionId', label: 'Ausprägung', required: true, type: 'reference', reference: { entity: 'property_group_option' } },
                { name: 'position', label: 'Position', type: 'integer', default: 1 }],
            columns: [{ field: 'optionId', label: 'Ausprägungs-ID' }, { field: 'position', label: 'Position', width: 100 }],
            detailTabs: (api, config, record) => api.can('currency:read') ? [currencyPricesPanel(api, config, 'product_configurator_setting', record.id, taxRate, 'Preisaufschläge', 'price', -Infinity)] : [] },
        { title: 'Cross-Selling', singular: 'Cross-Selling', entity: 'product_cross_selling',
            fields: [{ name: 'name', label: 'Titel', required: true }, { name: 'active', label: 'Aktiv', type: 'boolean' },
                { name: 'position', label: 'Position', type: 'integer', required: true, min: 0, default: 1 },
                { name: 'type', label: 'Zuweisung', type: 'select', required: true, default: 'productList', options: [['productList', 'Produktauswahl'], ['productStream', 'Dynamische Produktgruppe']] },
                { name: 'productStreamId', label: 'Produktgruppe', type: 'reference', reference: { entity: 'product_stream' } },
                { name: 'limit', label: 'Maximale Produktanzahl', type: 'integer', min: 1, default: 24 },
                { name: 'sortBy', label: 'Sortierung', type: 'select', default: 'name', options: [['name', 'Name'], ['cheapestPrice', 'Preis'], ['releaseDate', 'Erscheinungsdatum']] },
                { name: 'sortDirection', label: 'Reihenfolge', type: 'select', default: 'ASC', options: [['ASC', 'Aufsteigend'], ['DESC', 'Absteigend']] }],
            columns: [{ field: 'name', label: 'Titel' }, { field: 'type', label: 'Zuweisung' }, { field: 'active', label: 'Aktiv', type: 'boolean', width: 90 }],
            prepare: (payload, original) => {
                if ((payload.type ?? original?.type) === 'productStream' && !(payload.productStreamId ?? original?.productStreamId)) throw new Error('Bitte eine dynamische Produktgruppe auswählen.');
                return payload;
            },
            detailTabs: (api, config, crossSelling) => {
                if (!api.can('product_cross_selling_assigned_products:read') || crossSelling.type !== 'productList') return [];
                const panel = entityListView(api, config, { title: 'Zugeordnete Produkte', singular: 'Produktzuordnung', entity: 'product_cross_selling_assigned_products',
                    filter: [{ type: 'equals', field: 'crossSellingId', value: crossSelling.id }], defaults: { crossSellingId: crossSelling.id },
                    sort: 'position', direction: 'ASC', search: ['product.productNumber', 'product.name'], associations: { product: {} },
                    columns: [{ field: 'product.productNumber', label: 'Artikelnummer' }, { field: 'product.name', label: 'Produkt' }, { field: 'position', label: 'Position', width: 100 }],
                    fields: [{ name: 'productId', label: 'Produkt', type: 'reference', required: true, reference: { entity: 'product', labelFields: ['productNumber', 'name'] } },
                        { name: 'position', label: 'Position', type: 'integer', default: 1, min: 0 }],
                });
                panel.setTitle('Produktauswahl'); return [panel];
            } },
    ];
    for (const definition of children) {
        if (!api.can(`${definition.entity}:read`)) continue;
        const scoped = { ...definition, search: [], sort: 'createdAt', direction: 'ASC', filter: [{ type: 'equals', field: 'productId', value: productId }], defaults: { productId } };
        const panel = entityListView(api, config, scoped);
        panel.setTitle(definition.title);
        if (definition.entity === 'product_media') panel.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'Als Titelbild setzen',
            disabled: !api.can('product:update'), handler: async () => {
                const selected = panel.getSelection()[0];
                if (!selected) return;
                try { await api.request(`/product/${productId}`, 'PATCH', { coverId: selected.id }); notify('Titelbild gesetzt.'); }
                catch (error) { if (api.user) showError(error); }
            } }] });
        if (definition.entity === 'product_download') panel.addDocked({ xtype: 'toolbar', dock: 'top', items: [
            { text: 'Download-Datei hochladen', disabled: !['media:create', 'media:update', 'product_download:create'].every(privilege => api.can(privilege)),
                handler: () => uploadDialog(api, async mediaId => {
                    await api.request('/product-download', 'POST', { productId, mediaId, position: 1 });
                    if (!panel.destroyed) panel.refreshRecords();
                }, { privateFile: true }) },
            { text: 'Datei herunterladen', disabled: !api.can('media:read'), handler: async () => {
                const selected = panel.getSelection()[0];
                if (!selected) { notify('Bitte zuerst eine Datei auswählen.'); return; }
                try {
                    const download = (await api.search('product-download', { ids: [selected.id], limit: 1 })).data[0];
                    await openMedia(api, download?.mediaId);
                } catch (error) { if (api.user) showError(error); }
            } },
        ] });
        tabs.push(['product_visibility', 'product_media', 'product_cross_selling', 'main_category'].includes(definition.entity) ? inheritedProductChildren(api, product, panel, scoped) : panel);
    }
    if (!product.parentId && api.can('product:read')) {
        if (['product_configurator_setting:read', 'property_group:read', 'property_group_option:read'].every(privilege => api.can(privilege))) tabs.push(variantSettingsPanel(api, product));
        const variants = entityListView(api, config, {
            title: 'Varianten', singular: 'Variante', entity: 'product', create: false, multiSelect: true, search: ['productNumber', 'name'], sort: 'productNumber', direction: 'ASC',
            filter: [{ type: 'equals', field: 'parentId', value: productId }], fields: [],
            columns: [{ field: 'productNumber', label: 'Artikelnummer' }, { field: 'name', label: 'Name' }, { field: 'stock', label: 'Bestand', width: 110 }],
            editor: (api, config, definition, id, onSaved) => editVariant(api, config, id, onSaved),
        });
        variants.setTitle('Varianten');
        variants.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'Varianten erzeugen',
            disabled: !['product:create', 'product_configurator_setting:read', 'property_group_option:read', 'property_group:read', 'currency:read'].every(privilege => api.can(privilege)),
            handler: () => openVariantGenerator(api, config, productId, () => { if (!variants.destroyed) variants.refreshRecords(); }),
        }] });
        const bulk = variants.getDockedItems('toolbar[dock="top"]')[0].add({ text: 'Varianten gemeinsam bearbeiten', disabled: true,
            handler: () => openProductBulk(api, config, variants.getSelection().map(row => row.id), () => variants.refreshRecords()) });
        variants.on('selectionchange', (selection, rows) => bulk.setDisabled(!rows.length || !api.can('product:update')));
        tabs.push(variants);
    }
    return tabs;
}
