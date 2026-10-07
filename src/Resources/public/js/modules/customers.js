import { openEntityEditor } from '../entity-editor.js';
import { uuid } from '../entity-data.js';
const field = (name, label, options = {}) => ({ name, label, ...options });
const ref = (name, label, entity, options = {}) => field(name, label, { type: 'reference', reference: { entity }, ...options });
const column = (field, label, options = {}) => ({ field, label, ...options });

export const customerModules = [{
    id: 'customers', title: 'Kunden', singular: 'Kunde', entity: 'customer', group: 'Kunden', icon: 'x-fa fa-users',
    search: ['customerNumber', 'firstName', 'lastName', 'email', 'company'], sort: 'createdAt', direction: 'DESC', activeFilter: true,
    labelFields: ['customerNumber', 'email'],
    columns: [column('customerNumber', 'Kundennummer', { width: 140 }), column('firstName', 'Vorname'), column('lastName', 'Nachname'),
        column('email', 'E-Mail'), column('active', 'Aktiv', { type: 'boolean', width: 80 }), column('createdAt', 'Registriert', { type: 'date', width: 170 })],
    fields: [
        field('customerNumber', 'Kundennummer', { required: true }), ref('salutationId', 'Anrede', 'salutation', { reference: { entity: 'salutation', labelFields: ['displayName'] } }),
        field('firstName', 'Vorname', { required: true }), field('lastName', 'Nachname', { required: true }), field('email', 'E-Mail', { type: 'email', required: true }),
        field('company', 'Firma'), field('title', 'Titel'), field('birthday', 'Geburtstag', { type: 'date', dateOnly: true }),
        field('accountType', 'Kontotyp', { type: 'select', required: true, default: 'private', options: [['private', 'Privat'], ['business', 'Geschäftlich']] }),
        field('active', 'Aktiv', { type: 'boolean', default: true }),
        ref('groupId', 'Kundengruppe', 'customer_group', { required: true }), ref('salesChannelId', 'Verkaufskanal', 'sales_channel', { required: true }),
        ref('languageId', 'Sprache', 'language', { required: true }), ref('boundSalesChannelId', 'An Verkaufskanal binden', 'sales_channel'),
        field('password', 'Initiales Passwort', { type: 'password', required: true, createOnly: true, group: 'Zugang' }),
        field('defaultBillingAddress.street', 'Straße und Hausnummer', { required: true, createOnly: true, group: 'Rechnungs- und Lieferadresse' }),
        field('defaultBillingAddress.zipcode', 'Postleitzahl', { createOnly: true, group: 'Rechnungs- und Lieferadresse' }),
        field('defaultBillingAddress.city', 'Ort', { required: true, createOnly: true, group: 'Rechnungs- und Lieferadresse' }),
        ref('defaultBillingAddress.countryId', 'Land', 'country', { required: true, createOnly: true, group: 'Rechnungs- und Lieferadresse' }),
        ref('defaultBillingAddress.countryStateId', 'Bundesland', 'country_state', { createOnly: true, group: 'Rechnungs- und Lieferadresse' }),
    ],
    defaults: config => ({ languageId: config.languageId, guest: false }),
    prepare: (payload, original) => {
        if (original) return payload;
        const addressId = uuid();
        payload.defaultBillingAddress = { ...payload.defaultBillingAddress, id: addressId,
            firstName: payload.firstName, lastName: payload.lastName, salutationId: payload.salutationId, company: payload.company };
        payload.defaultBillingAddressId = addressId;
        payload.defaultShippingAddressId = addressId;
        return payload;
    },
    editor: (api, config, definition, id, onSaved) => {
        const addresses = id ? ['defaultBillingAddressId', 'defaultShippingAddressId'].map((name, index) => ref(name,
            index ? 'Standard-Lieferadresse' : 'Standard-Rechnungsadresse', 'customer_address', {
                group: 'Standardadressen', required: true,
                reference: { entity: 'customer_address', labelFields: ['street', 'zipcode', 'city'], search: ['street', 'city'],
                    filter: [{ type: 'equals', field: 'customerId', value: id }] },
            })) : [];
        return openEntityEditor(api, config, { ...definition, fields: [...definition.fields, ...addresses] }, id, onSaved);
    },
}, {
    id: 'customer-addresses', title: 'Kundenadressen', singular: 'Adresse', entity: 'customer_address', group: 'Kunden', icon: 'x-fa fa-address-book',
    search: ['firstName', 'lastName', 'street', 'city', 'zipcode', 'company'], sort: 'createdAt', direction: 'DESC',
    labelFields: ['street', 'city'],
    columns: [column('firstName', 'Vorname'), column('lastName', 'Nachname'), column('street', 'Straße'), column('zipcode', 'PLZ', { width: 100 }), column('city', 'Ort')],
    fields: [
        ref('customerId', 'Kunde', 'customer', { required: true, createOnly: true, reference: { entity: 'customer', labelFields: ['customerNumber', 'firstName', 'lastName', 'email'], search: ['customerNumber', 'email', 'lastName'] } }),
        ref('salutationId', 'Anrede', 'salutation', { reference: { entity: 'salutation', labelFields: ['displayName'] } }),
        field('firstName', 'Vorname', { required: true }), field('lastName', 'Nachname', { required: true }), field('company', 'Firma'), field('department', 'Abteilung'),
        field('street', 'Straße und Hausnummer', { required: true }), field('zipcode', 'Postleitzahl'), field('city', 'Ort', { required: true }),
        ref('countryId', 'Land', 'country', { required: true }), ref('countryStateId', 'Bundesland', 'country_state'),
        field('phoneNumber', 'Telefon'), field('additionalAddressLine1', 'Adresszusatz 1'), field('additionalAddressLine2', 'Adresszusatz 2'),
    ],
}];
