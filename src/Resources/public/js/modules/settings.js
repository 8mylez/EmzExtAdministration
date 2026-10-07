import { shippingPricesTabs } from './shipping-prices.js';
import { taxTabs, numberRangeTabs } from './settings-details.js';

const text = (name, label, options = {}) => ({ name, label, ...options });
const bool = (name, label, options = {}) => ({ name, label, type: 'boolean', ...options });
const integer = (name, label, options = {}) => ({ name, label, type: 'integer', ...options });
const number = (name, label, options = {}) => ({ name, label, type: 'number', ...options });
const select = (name, label, options, defaults = {}) => ({ name, label, type: 'select', options, ...defaults });
const ref = (name, label, entity, options = {}) => ({ name, label, type: 'reference', reference: { entity }, ...options });
const column = (field, label, options = {}) => ({ field, label, ...options });
const settings = (id, title, singular, entity, fields, columns, extra = {}) => ({
    id, title, singular, entity, group: 'Einstellungen', icon: 'x-fa fa-cog',
    search: ['name'], sort: 'name', direction: 'ASC', fields, columns: columns || [column('name', 'Name')], ...extra,
});

export const settingsModules = [
    settings('taxes', 'Steuersätze', 'Steuersatz', 'tax', [
        text('name', 'Name', { required: true }), number('taxRate', 'Steuersatz (%)', { required: true, min: 0, max: 100 }),
        integer('position', 'Position', { required: true, default: 1 }),
    ], [column('name', 'Name'), column('taxRate', 'Steuersatz (%)', { width: 160 }), column('position', 'Position', { width: 100 })], { detailTabs: taxTabs }),
    settings('delivery-times', 'Lieferzeiten', 'Lieferzeit', 'delivery_time', [
        text('name', 'Name', { required: true }), integer('min', 'Mindestens', { required: true, min: 0, default: 1 }),
        integer('max', 'Höchstens', { required: true, min: 0, default: 3 }),
        select('unit', 'Einheit', [['hour', 'Stunden'], ['day', 'Tage'], ['week', 'Wochen'], ['month', 'Monate'], ['year', 'Jahre']], { required: true, default: 'day' }),
    ], [column('name', 'Name'), column('min', 'Minimum', { width: 120 }), column('max', 'Maximum', { width: 120 }), column('unit', 'Einheit', { width: 140 })], {
        prepare: (payload, record) => {
            if ((payload.min ?? record?.min) > (payload.max ?? record?.max)) throw new Error('Die minimale Lieferzeit darf nicht größer als die maximale sein.');
            return payload;
        },
    }),
    settings('units', 'Maßeinheiten', 'Maßeinheit', 'unit', [text('name', 'Name', { required: true }), text('shortCode', 'Kürzel', { required: true })],
        [column('name', 'Name'), column('shortCode', 'Kürzel', { width: 160 })]),
    settings('salutations', 'Anreden', 'Anrede', 'salutation', [
        text('salutationKey', 'Technischer Name', { required: true }), text('displayName', 'Anzeigename', { required: true }),
        text('letterName', 'Briefanrede', { required: true }), integer('position', 'Position', { default: 1 }),
    ], [column('displayName', 'Name'), column('salutationKey', 'Technischer Name'), column('letterName', 'Briefanrede')], {
        search: ['displayName', 'salutationKey'], sort: 'displayName', labelFields: ['displayName'],
    }),
    settings('customer-groups', 'Kundengruppen', 'Kundengruppe', 'customer_group', [
        text('name', 'Name', { required: true }), bool('displayGross', 'Bruttopreise anzeigen', { default: true }),
        bool('registrationActive', 'Eigene Registrierung aktiv', { group: 'Registrierung' }),
        text('registrationTitle', 'Titel', { group: 'Registrierung' }),
        text('registrationIntroduction', 'Einleitung (HTML)', { type: 'textarea', group: 'Registrierung' }),
        bool('registrationOnlyCompanyRegistration', 'Nur Firmenregistrierung', { group: 'Registrierung' }),
        text('registrationSeoMetaDescription', 'Meta-Beschreibung', { type: 'textarea', group: 'Registrierung' }),
    ], [column('name', 'Name'), column('displayGross', 'Bruttopreise', { type: 'boolean', width: 130 }), column('registrationActive', 'Registrierung aktiv', { type: 'boolean', width: 160 })]),
    settings('countries', 'Länder', 'Land', 'country', [
        text('name', 'Name', { required: true }), text('iso', 'ISO-2-Code', { maxLength: 2 }), text('iso3', 'ISO-3-Code', { maxLength: 3 }),
        bool('active', 'Aktiv', { default: true }), bool('shippingAvailable', 'Für Versand verfügbar', { default: true }),
        bool('isEu', 'EU-Mitglied'), integer('position', 'Position', { default: 1 }),
        bool('postalCodeRequired', 'Postleitzahl erforderlich', { group: 'Adresse', default: true }),
        bool('displayStateInRegistration', 'Bundesland anzeigen', { group: 'Adresse' }),
        bool('forceStateInRegistration', 'Bundesland erforderlich', { group: 'Adresse' }),
        bool('checkVatIdPattern', 'USt-IdNr. prüfen', { group: 'Umsatzsteuer' }),
        bool('vatIdRequired', 'USt-IdNr. erforderlich', { group: 'Umsatzsteuer' }), text('vatIdPattern', 'USt-IdNr.-Muster', { group: 'Umsatzsteuer' }),
    ], [column('name', 'Land'), column('iso', 'ISO', { width: 100 }), column('active', 'Aktiv', { type: 'boolean', width: 100 }), column('isEu', 'EU', { type: 'boolean', width: 100 })], { create: false, activeFilter: true }),
    settings('country-states', 'Bundesländer', 'Bundesland', 'country_state', [
        text('name', 'Name', { required: true }), text('shortCode', 'Kürzel', { required: true }),
        ref('countryId', 'Land', 'country', { required: true }), integer('position', 'Position', { default: 1 }), bool('active', 'Aktiv', { default: true }),
    ], [column('name', 'Name'), column('shortCode', 'Kürzel'), column('active', 'Aktiv', { type: 'boolean', width: 100 })], { activeFilter: true }),
    settings('currencies', 'Währungen', 'Währung', 'currency', [
        text('name', 'Name', { required: true }), text('shortName', 'Kurzname', { required: true }),
        text('isoCode', 'ISO-Code', { required: true, maxLength: 3 }), text('symbol', 'Symbol', { required: true }),
        number('factor', 'Faktor zur Systemwährung', { required: true, min: 0.00000001, default: 1 }),
        integer('position', 'Position', { default: 1 }), number('taxFreeFrom', 'Steuerfrei ab', { min: 0 }),
        integer('itemRounding.decimals', 'Nachkommastellen Positionen', { required: true, min: 0, max: 10, default: 2, group: 'Rundung' }),
        number('itemRounding.interval', 'Rundungsintervall Positionen', { required: true, min: 0.00000001, default: 0.01, group: 'Rundung' }),
        bool('itemRounding.roundForNet', 'Positionen auch netto runden', { default: true, group: 'Rundung' }),
        integer('totalRounding.decimals', 'Nachkommastellen Gesamt', { required: true, min: 0, max: 10, default: 2, group: 'Rundung' }),
        number('totalRounding.interval', 'Rundungsintervall Gesamt', { required: true, min: 0.00000001, default: 0.01, group: 'Rundung' }),
        bool('totalRounding.roundForNet', 'Gesamt auch netto runden', { default: true, group: 'Rundung' }),
    ], [column('name', 'Name'), column('isoCode', 'ISO', { width: 100 }), column('symbol', 'Symbol', { width: 100 }), column('factor', 'Faktor', { width: 140 })], {
        prepare: payload => {
            // CashRoundingConfig also serializes extensions/apiAlias; only its settings are writable.
            for (const field of ['itemRounding', 'totalRounding']) if (payload[field]) {
                payload[field] = Object.fromEntries(['decimals', 'interval', 'roundForNet'].map(key => [key, payload[field][key]]));
            }
            return payload;
        },
    }),
    settings('languages', 'Sprachen', 'Sprache', 'language', [
        text('name', 'Name', { required: true }), bool('active', 'Aktiv', { default: true }),
        ref('parentId', 'Übergeordnete Sprache', 'language'),
        ref('localeId', 'Lokalisierung', 'locale', { required: true, reference: { entity: 'locale', labelFields: ['code', 'name'] } }),
        ref('translationCodeId', 'Übersetzungssprache', 'locale', { reference: { entity: 'locale', labelFields: ['code', 'name'] } }),
    ], [column('name', 'Name'), column('active', 'Aktiv', { type: 'boolean', width: 100 })], { activeFilter: true }),
    settings('payment-methods', 'Zahlungsarten', 'Zahlungsart', 'payment_method', [
        text('name', 'Name', { required: true }), text('technicalName', 'Technischer Name', { required: true }), bool('active', 'Aktiv'),
        bool('afterOrderEnabled', 'Nach Bestellabschluss verfügbar'), integer('position', 'Position', { default: 1 }),
        text('description', 'Beschreibung (HTML)', { type: 'textarea' }), ref('availabilityRuleId', 'Verfügbarkeitsregel', 'rule'),
    ], [column('name', 'Name'), column('technicalName', 'Technischer Name'), column('active', 'Aktiv', { type: 'boolean', width: 100 })], { activeFilter: true, create: false, delete: false }),
    settings('shipping-methods', 'Versandarten', 'Versandart', 'shipping_method', [
        text('name', 'Name', { required: true }), text('technicalName', 'Technischer Name', { required: true }), bool('active', 'Aktiv'),
        integer('position', 'Position', { default: 1 }), ref('deliveryTimeId', 'Lieferzeit', 'delivery_time', { required: true }),
        ref('availabilityRuleId', 'Verfügbarkeitsregel', 'rule'),
        select('taxType', 'Steuerberechnung', [['auto', 'Automatisch'], ['highest', 'Höchster Steuersatz'], ['fixed', 'Fester Steuersatz']], { required: true, default: 'auto' }),
        ref('taxId', 'Fester Steuersatz', 'tax'), text('description', 'Beschreibung (HTML)', { type: 'textarea' }), text('trackingUrl', 'Tracking-URL'),
    ], [column('name', 'Name'), column('technicalName', 'Technischer Name'), column('active', 'Aktiv', { type: 'boolean', width: 100 })], { activeFilter: true, detailTabs: shippingPricesTabs }),
    settings('number-ranges', 'Nummernkreise', 'Nummernkreis', 'number_range', [
        text('name', 'Name', { required: true }), text('description', 'Beschreibung'), text('pattern', 'Muster (z. B. {n})', { required: true, default: '{n}' }),
        integer('start', 'Startwert', { required: true, min: 0, default: 10000 }), bool('global', 'Global', { default: true }),
        ref('typeId', 'Typ', 'number_range_type', { required: true, reference: { entity: 'number_range_type', labelFields: ['typeName'] } }),
    ], [column('name', 'Name'), column('pattern', 'Muster'), column('start', 'Startwert', { width: 130 }), column('global', 'Global', { type: 'boolean', width: 100 })], { detailTabs: numberRangeTabs }),
    settings('mail-templates', 'E-Mail-Vorlagen', 'E-Mail-Vorlage', 'mail_template', [
        ref('mailTemplateTypeId', 'Vorlagentyp', 'mail_template_type', { required: true }), text('description', 'Beschreibung'),
        text('senderName', 'Absendername'), text('subject', 'Betreff', { required: true }),
        text('contentHtml', 'Inhalt (HTML/Twig)', { required: true, type: 'textarea', height: 240, group: 'Inhalt' }),
        text('contentPlain', 'Inhalt (Text/Twig)', { required: true, type: 'textarea', height: 200, group: 'Inhalt' }),
    ], [column('subject', 'Betreff'), column('description', 'Beschreibung'), column('senderName', 'Absender')], {
        search: ['subject', 'description'], sort: 'subject', labelFields: ['subject'], defaults: { systemDefault: false, wasModifiedByUser: true },
    }),
    settings('mail-layouts', 'E-Mail-Layouts', 'E-Mail-Layout', 'mail_header_footer', [
        text('name', 'Name', { required: true }), text('description', 'Beschreibung'),
        text('headerHtml', 'Kopfzeile (HTML/Twig)', { type: 'textarea', group: 'Kopfzeile' }), text('headerPlain', 'Kopfzeile (Text/Twig)', { type: 'textarea', group: 'Kopfzeile' }),
        text('footerHtml', 'Fußzeile (HTML/Twig)', { type: 'textarea', group: 'Fußzeile' }), text('footerPlain', 'Fußzeile (Text/Twig)', { type: 'textarea', group: 'Fußzeile' }),
    ]),
];
