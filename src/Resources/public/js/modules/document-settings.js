import { entityListView } from '../entity-list.js';

const field = (name, label, options = {}) => ({ name, label, ...options });
const ref = (name, label, entity, options = {}) => field(name, label, { type: 'reference', reference: { entity }, ...options });
const option = (name, label, options = {}) => field(`config.${name}`, label, options);

export const documentSettingsModule = {
    id: 'document-settings', title: 'Dokumentvorlagen', singular: 'Dokumentvorlage', entity: 'document_base_config', group: 'Einstellungen', icon: 'x-fa fa-file-alt',
    search: ['name'], sort: 'name', direction: 'ASC', associations: { documentType: {} }, isDeleteLocked: record => record?.global,
    columns: [{ field: 'name', label: 'Name' }, { field: 'documentType.name', label: 'Belegtyp' }, { field: 'global', label: 'Standardvorlage', type: 'boolean', width: 140 }],
    defaults: { global: false },
    fields: [field('name', 'Name', { required: true }), ref('documentTypeId', 'Belegtyp', 'document_type', { required: true, createOnly: true }),
        field('global', 'Standardvorlage', { type: 'boolean', readOnly: true, editOnly: true }),
        ref('logoId', 'Logo', 'media', { reference: { entity: 'media', labelFields: ['fileName'] } }),
        field('filenamePrefix', 'Dateiname: Präfix'), field('filenameSuffix', 'Dateiname: Suffix'),
        option('pageSize', 'Papierformat', { type: 'select', default: 'a4', options: [['a4', 'A4'], ['a5', 'A5'], ['letter', 'Letter'], ['legal', 'Legal']], group: 'Darstellung' }),
        option('pageOrientation', 'Ausrichtung', { type: 'select', default: 'portrait', options: [['portrait', 'Hochformat'], ['landscape', 'Querformat']], group: 'Darstellung' }),
        option('itemsPerPage', 'Positionen je Seite', { type: 'integer', min: 1, default: 10, group: 'Darstellung' }),
        ...[['displayHeader', 'Kopfzeile'], ['displayFooter', 'Fußzeile'], ['displayPageCount', 'Seitenzahl'], ['displayLineItems', 'Positionen'],
            ['displayLineItemPosition', 'Positionsnummern'], ['displayPrices', 'Preise'], ['displayInCustomerAccount', 'Im Kundenkonto anzeigen'],
            ['displayCompanyAddress', 'Firmenanschrift'], ['displayReturnAddress', 'Absenderzeile'], ['displayCustomerVatId', 'USt-IdNr. des Kunden'],
            ['displayDivergentDeliveryAddress', 'Abweichende Lieferadresse'], ['displayAdditionalNoteDelivery', 'Zusätzlicher Lieferhinweis']]
            .map(([name, label]) => option(name, label, { type: 'boolean', default: true, group: 'Darstellung' })),
        ...[['companyName', 'Firma'], ['companyStreet', 'Straße'], ['companyZipcode', 'Postleitzahl'], ['companyCity', 'Ort'], ['companyEmail', 'E-Mail'], ['companyPhone', 'Telefon'],
            ['companyUrl', 'Website'], ['taxNumber', 'Steuernummer'], ['taxOffice', 'Finanzamt'], ['vatId', 'USt-IdNr.'], ['bankName', 'Bank'], ['bankIban', 'IBAN'], ['bankBic', 'BIC'],
            ['placeOfJurisdiction', 'Gerichtsstand'], ['placeOfFulfillment', 'Erfüllungsort'], ['executiveDirector', 'Geschäftsführung']]
            .map(([name, label]) => option(name, label, { group: 'Firmendaten' })),
        ref('config.companyCountryId', 'Land', 'country', { group: 'Firmendaten' }),
        option('fileTypes', 'Dateiformate', { type: 'multiselect', options: [['pdf', 'PDF'], ['html', 'HTML']], default: ['pdf'], required: true, group: 'Darstellung' }),
        option('paymentDueDate', 'Zahlungsziel', { group: 'Weitere Angaben' }), option('documentComment', 'Zusätzlicher Hinweis', { type: 'textarea', group: 'Weitere Angaben' }),
        option('deliveryCountries', 'Lieferländer', { type: 'reference', reference: { entity: 'country' }, multiple: true, group: 'Weitere Angaben' }),
    ],
    prepare: async (payload, original, { api }) => {
        if (payload.documentTypeId) {
            const type = (await api.search('document-type', { ids: [payload.documentTypeId], limit: 1 })).data[0];
            if (!type) throw new Error('Der Belegtyp wurde nicht gefunden.');
            payload.typeName = type.technicalName;
        }
        return payload;
    },
    detailTabs: (api, config, document) => {
        if (document.global || !api.can('document_base_config_sales_channel:read')) return [];
        const panel = entityListView(api, config, { title: 'Verkaufskanäle', singular: 'Vorlagenzuordnung', entity: 'document_base_config_sales_channel',
            search: ['salesChannel.name'], sort: 'createdAt', direction: 'DESC', associations: { salesChannel: {} },
            filter: [{ type: 'equals', field: 'documentBaseConfigId', value: document.id }],
            defaults: { documentBaseConfigId: document.id, documentTypeId: document.documentTypeId, typeName: document.typeName },
            fields: [ref('salesChannelId', 'Verkaufskanal', 'sales_channel', { required: true })], columns: [{ field: 'salesChannel.name', label: 'Verkaufskanal' }],
        }); panel.setTitle('Verkaufskanäle'); return [panel];
    },
};
