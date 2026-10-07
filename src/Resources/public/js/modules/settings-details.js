import { entityListView } from '../entity-list.js';

const f = (name, label, options = {}) => ({ name, label, ...options });
const ref = (name, label, entity, options = {}) => f(name, label, { type: 'reference', reference: { entity }, ...options });
const col = (field, label, options = {}) => ({ field, label, ...options });
const filter = (field, value) => [{ type: 'equals', field, value }];
function tab(api, config, definition) {
    const panel = entityListView(api, config, definition); panel.setTitle(definition.title); return panel;
}

export function taxTabs(api, config, tax) {
    if (!api.can('tax_rule:read')) return [];
    return [tab(api, config, { title: 'Länderregeln', singular: 'Länderregel', entity: 'tax_rule',
        search: ['country.name'], sort: 'createdAt', associations: { country: {}, type: {} },
        filter: filter('taxId', tax.id), defaults: { taxId: tax.id },
        columns: [col('country.name', 'Land'), col('type.typeName', 'Regeltyp'), col('taxRate', 'Steuersatz (%)'), col('activeFrom', 'Gültig ab', { type: 'date' })],
        fields: [ref('countryId', 'Land', 'country', { required: true }), ref('taxRuleTypeId', 'Regeltyp', 'tax_rule_type', { required: true, reference: { entity: 'tax_rule_type', labelFields: ['typeName'] } }),
            f('taxRate', 'Steuersatz (%)', { type: 'number', required: true, min: 0, max: 100 }), f('activeFrom', 'Gültig ab', { type: 'datetime' }),
            ref('data.states', 'Bundesländer (bei Bundesland-Regel)', 'country_state', { multiple: true }),
            f('data.zipCode', 'Postleitzahl (bei PLZ-Regel)'), f('data.fromZipCode', 'Postleitzahl von (bei PLZ-Bereich)'), f('data.toZipCode', 'Postleitzahl bis (bei PLZ-Bereich)'),
        ],
        prepare: async (payload, original, { values }) => {
            const type = (await api.search('tax-rule-type', { ids: [values.taxRuleTypeId], limit: 1 })).data[0];
            const data = { ...original?.data, ...payload.data };
            if (type?.technicalName === 'individual_states') {
                if (!data.states?.length) throw new Error('Bitte mindestens ein Bundesland auswählen.');
                const states = await api.search('country-state', { ids: data.states, limit: Math.min(data.states.length, 500) });
                if (states.data.some(state => state.countryId !== values.countryId)) throw new Error('Alle Bundesländer müssen zum ausgewählten Land gehören.');
            }
            if (type?.technicalName === 'zip_code' && !data.zipCode) throw new Error('Bitte eine Postleitzahl eingeben.');
            if (type?.technicalName === 'zip_code_range' && (!data.fromZipCode || !data.toZipCode || data.fromZipCode > data.toZipCode)) throw new Error('Bitte einen gültigen Postleitzahlbereich eingeben.');
            return payload;
        },
    })];
}

export function numberRangeTabs(api, config, range) {
    const tabs = [];
    if (api.can('number_range_state:read')) tabs.push(tab(api, config, { title: 'Zählerstand', singular: 'Zählerstand', entity: 'number_range_state', create: false, delete: false,
        search: [], filter: filter('numberRangeId', range.id), sort: 'createdAt', columns: [col('lastValue', 'Zuletzt vergeben')], fields: [f('lastValue', 'Zuletzt vergeben', { type: 'integer', readOnly: true })] }));
    if (!range.global && api.can('number_range_sales_channel:read')) tabs.push(tab(api, config, { title: 'Verkaufskanäle', singular: 'Nummernkreiszuordnung', entity: 'number_range_sales_channel',
        search: ['salesChannel.name'], sort: 'createdAt', associations: { salesChannel: {} }, filter: filter('numberRangeId', range.id),
        defaults: { numberRangeId: range.id, numberRangeTypeId: range.typeId }, fields: [ref('salesChannelId', 'Verkaufskanal', 'sales_channel', { required: true })], columns: [col('salesChannel.name', 'Verkaufskanal')] }));
    return tabs;
}

const searchFields = [['name', 'Produktname'], ['parent.name', 'Name des Hauptprodukts'], ['description', 'Beschreibung'], ['productNumber', 'Produktnummer'], ['manufacturerNumber', 'Herstellernummer'], ['ean', 'EAN'],
    ['customSearchKeywords', 'Suchbegriffe'], ['manufacturer.name', 'Hersteller'], ['manufacturer.customFields', 'Hersteller-Zusatzfelder'], ['categories.name', 'Kategorien'], ['categories.customFields', 'Kategorie-Zusatzfelder'],
    ['tags.name', 'Tags'], ['metaTitle', 'Meta-Titel'], ['metaDescription', 'Meta-Beschreibung'], ['properties.name', 'Eigenschaften'], ['options.name', 'Ausprägungen'], ['customFields', 'Produkt-Zusatzfeld']];
export const advancedSettingsModules = [
    { id: 'search-settings', title: 'Suchkonfiguration', singular: 'Suchkonfiguration', entity: 'product_search_config', group: 'Einstellungen',
        search: ['language.name'], sort: 'createdAt', associations: { language: {} },
        columns: [col('language.name', 'Sprache'), col('minSearchLength', 'Mindestlänge'), col('andLogic', 'Alle Wörter erforderlich', { type: 'boolean' })],
        fields: [ref('languageId', 'Sprache', 'language', { required: true, createOnly: true }), f('andLogic', 'Alle Suchwörter müssen vorkommen', { type: 'boolean', default: true }),
            f('minSearchLength', 'Mindestlänge des Suchbegriffs', { type: 'integer', required: true, min: 1, default: 2 }), f('excludedTerms', 'Ausgeschlossene Wörter (eines je Zeile)', { type: 'lines' })],
        detailTabs: (api, config, search) => api.can('product_search_config_field:read') ? [tab(api, config, { title: 'Durchsuchbare Felder', singular: 'Suchfeld', entity: 'product_search_config_field',
            search: ['field'], sort: 'ranking', direction: 'DESC', filter: filter('searchConfigId', search.id), defaults: { searchConfigId: search.id },
            columns: [col('field', 'Feld'), col('ranking', 'Gewichtung'), col('searchable', 'Durchsuchbar', { type: 'boolean' }), col('tokenize', 'Wortweise', { type: 'boolean' })],
            fields: [f('field', 'Feld', { type: 'select', options: searchFields, required: true, initialValue: record => record.field?.startsWith('customFields.') ? 'customFields' : record.field }), ref('customFieldId', 'Zusatzfeld (für Produkt-Zusatzfeld)', 'custom_field', { reference: { entity: 'custom_field', filter: [{ type: 'equals', field: 'customFieldSet.relations.entityName', value: 'product' }] } }),
                f('ranking', 'Gewichtung', { type: 'integer', min: 0, required: true, default: 500 }), f('searchable', 'Durchsuchbar', { type: 'boolean', default: true }),
                f('tokenize', 'Text in Suchwörter zerlegen', { type: 'boolean', default: true }), f('useExactSubfield', 'Exakte Wortsuche verwenden', { type: 'boolean' })],
            prepare: async (payload, original, { values }) => {
                if (values.field === 'customFields') {
                    if (!values.customFieldId) throw new Error('Bitte ein Zusatzfeld wählen.');
                    const field = (await api.search('custom-field', { ids: [values.customFieldId], limit: 1 })).data[0];
                    payload.field = `customFields.${field.name}`;
                } else if (original?.customFieldId || payload.customFieldId) payload.customFieldId = null;
                return payload;
            },
        })] : [],
    },
    { id: 'state-machines', title: 'Statusverwaltung', singular: 'Statusgruppe', entity: 'state_machine', group: 'Einstellungen', create: false, delete: false,
        search: ['name', 'technicalName'], sort: 'technicalName', direction: 'ASC', columns: [col('name', 'Name'), col('technicalName', 'Technischer Name')],
        fields: [f('name', 'Name', { required: true }), f('technicalName', 'Technischer Name', { readOnly: true })],
        detailTabs: (api, config, machine) => [
            ...(api.can('state_machine_state:read') ? [tab(api, config, { title: 'Status', singular: 'Status', entity: 'state_machine_state', create: false, delete: false,
                search: ['name', 'technicalName'], sort: 'technicalName', filter: filter('stateMachineId', machine.id), columns: [col('name', 'Name'), col('technicalName', 'Technischer Name')],
                fields: [f('name', 'Name', { required: true }), f('technicalName', 'Technischer Name', { readOnly: true })] })] : []),
            ...(api.can('state_machine_transition:read') ? [tab(api, config, { title: 'Übergänge', singular: 'Übergang', entity: 'state_machine_transition', create: false, delete: false,
                search: ['actionName'], sort: 'actionName', filter: filter('stateMachineId', machine.id), associations: { fromStateMachineState: {}, toStateMachineState: {} },
                columns: [col('actionName', 'Aktion'), col('fromStateMachineState.name', 'Von'), col('toStateMachineState.name', 'Nach')],
                fields: [f('actionName', 'Aktion', { readOnly: true }), ref('fromStateId', 'Von', 'state_machine_state', { readOnly: true }), ref('toStateId', 'Nach', 'state_machine_state', { readOnly: true })] })] : []),
        ],
    },
];
