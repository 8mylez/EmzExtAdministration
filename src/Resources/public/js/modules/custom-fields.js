import { entityListView } from '../entity-list.js';

const entities = [['product', 'Produkte'], ['category', 'Kategorien'], ['customer', 'Kunden'], ['customer_address', 'Kundenadressen'],
    ['order', 'Bestellungen'], ['product_manufacturer', 'Hersteller'], ['sales_channel', 'Verkaufskanäle'], ['media', 'Medien'],
    ['landing_page', 'Landingpages'], ['promotion', 'Aktionen'], ['product_stream', 'Produktgruppen'], ['property_group', 'Eigenschaften'],
    ['property_group_option', 'Ausprägungen'], ['product_review', 'Bewertungen'], ['country', 'Länder'], ['currency', 'Währungen'],
    ['customer_group', 'Kundengruppen'], ['delivery_time', 'Lieferzeiten'], ['document_base_config', 'Belege'], ['language', 'Sprachen'],
    ['number_range', 'Nummernkreise'], ['payment_method', 'Zahlungsarten'], ['rule', 'Regeln'], ['salutation', 'Anreden'],
    ['shipping_method', 'Versandarten'], ['tax', 'Steuern'], ['unit', 'Maßeinheiten'], ['newsletter_recipient', 'Newsletter-Empfänger']];
const types = [['text', 'Text'], ['html', 'HTML'], ['bool', 'Checkbox'], ['int', 'Ganzzahl'], ['float', 'Dezimalzahl'], ['datetime', 'Datum/Uhrzeit'],
    ['select', 'Auswahl'], ['media', 'Medium'], ['entity', 'Datensatz-Auswahl'], ['json', 'JSON']];
const components = { text: 'sw-field', html: 'sw-text-editor', bool: 'sw-field', int: 'sw-field', float: 'sw-field', datetime: 'sw-field', media: 'sw-media-field' };
const validName = (name, label) => { if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`${label}: Nur Buchstaben, Zahlen und Unterstriche; das erste Zeichen darf keine Zahl sein.`); };

export const customFieldsModule = {
    id: 'custom-fields', title: 'Zusatzfelder', singular: 'Zusatzfeld-Set', entity: 'custom_field_set', group: 'Einstellungen', icon: 'x-fa fa-list',
    search: ['name'], sort: 'position', direction: 'ASC', columns: [{ field: 'name', label: 'Technischer Name' }, { field: 'config.label.de-DE', label: 'Beschriftung' },
        { field: 'active', label: 'Aktiv', type: 'boolean', width: 90 }, { field: 'global', label: 'Global', type: 'boolean', width: 90 }],
    fields: [{ name: 'name', label: 'Technischer Name', required: true, createOnly: true },
        { name: 'config.label.de-DE', label: 'Beschriftung Deutsch', required: true }, { name: 'config.label.en-GB', label: 'Beschriftung Englisch' },
        { name: 'active', label: 'Aktiv', type: 'boolean', default: true }, { name: 'global', label: 'Bei Produkten global verwenden', type: 'boolean', default: true },
        { name: 'position', label: 'Position', type: 'integer', min: 0, default: 1 }],
    isLocked: record => Boolean(record?.appId || record?.extensionName),
    prepare: (payload, original) => { if (!original) validName(payload.name, 'Technischer Name'); return payload; },
    detailTabs: (api, config, set) => {
        const tabs = [];
        if (api.can('custom_field_set_relation:read')) {
            const panel = entityListView(api, config, { title: 'Verwendung', singular: 'Verwendung', entity: 'custom_field_set_relation',
                filter: [{ type: 'equals', field: 'customFieldSetId', value: set.id }], defaults: { customFieldSetId: set.id }, search: [], sort: 'createdAt',
                create: !set.appId && !set.extensionName, delete: !set.appId && !set.extensionName,
                columns: [{ field: 'entityName', label: 'Bereich', render: name => entities.find(item => item[0] === name)?.[1] || name }],
                fields: [{ name: 'entityName', label: 'Bereich', type: 'select', options: entities, required: true }], isLocked: () => Boolean(set.appId || set.extensionName),
            }); panel.setTitle('Verwendung'); tabs.push(panel);
        }
        if (api.can('custom_field:read')) {
            const definition = { title: 'Felder', singular: 'Zusatzfeld', entity: 'custom_field', search: ['name'], sort: 'name', direction: 'ASC',
                filter: [{ type: 'equals', field: 'customFieldSetId', value: set.id }], defaults: { customFieldSetId: set.id },
                create: !set.appId && !set.extensionName, delete: !set.appId && !set.extensionName, isLocked: () => Boolean(set.appId || set.extensionName),
                columns: [{ field: 'name', label: 'Technischer Name' }, { field: 'config.label.de-DE', label: 'Beschriftung' }, { field: 'type', label: 'Datentyp', width: 100 }],
                fields: [{ name: 'name', label: 'Technischer Name', required: true, createOnly: true },
                    { name: 'inputType', label: 'Feldtyp', type: 'select', required: true, createOnly: true, options: types, default: 'text' },
                    { name: 'config.label.de-DE', label: 'Beschriftung Deutsch', required: true }, { name: 'config.label.en-GB', label: 'Beschriftung Englisch' },
                    { name: 'config.helpText.de-DE', label: 'Hilfetext' }, { name: 'config.customFieldPosition', label: 'Position', type: 'integer', min: 0, default: 1 },
                    { name: 'active', label: 'Aktiv', type: 'boolean', default: true },
                    { name: 'storeApiAware', label: 'In der Store API verfügbar', type: 'boolean', default: true },
                    { name: 'allowCustomerWrite', label: 'Kunden dürfen dieses Feld ändern', type: 'boolean' },
                    { name: 'allowCartExpose', label: 'Im Warenkorb verfügbar', type: 'boolean' }, { name: 'includeInSearch', label: 'In Suche einbeziehen', type: 'boolean' },
                    { name: 'optionsText', label: 'Auswahlwerte (pro Zeile Schlüssel = Beschriftung)', type: 'textarea', group: 'Auswahl',
                        initialValue: record => record.config?.options?.map(option => `${option.value} = ${option.label?.['de-DE'] || option.value}`).join('\n') },
                    { name: 'config.entity', label: 'Bereich für Datensatz-Auswahl', type: 'select', options: entities, group: 'Auswahl' },
                    { name: 'multiple', label: 'Mehrfachauswahl', type: 'boolean', group: 'Auswahl', initialValue: record => ['sw-multi-select', 'sw-entity-multi-id-select'].includes(record.config?.componentName) }],
                prepare: (payload, original, { values }) => {
                    const type = original?.config?.customFieldType || values.inputType;
                    if (!original) {
                        validName(payload.name, 'Technischer Name');
                        payload.type = type === 'entity' ? 'select' : type === 'media' ? 'text' : type;
                        payload.config = { ...payload.config, customFieldType: type, componentName: components[type] || 'sw-field',
                            type: { bool: 'checkbox', int: 'number', float: 'number', datetime: 'date' }[type] || 'text',
                            ...(type === 'float' ? { numberType: 'float' } : {}), ...(type === 'int' ? { numberType: 'int' } : {}) };
                    }
                    if (['entity', 'select'].includes(type)) {
                        payload.config ??= structuredClone(original?.config || {});
                        payload.config.componentName = type === 'entity' ? values.multiple ? 'sw-entity-multi-id-select' : 'sw-entity-single-select' : values.multiple ? 'sw-multi-select' : 'sw-single-select';
                        if (type === 'entity' && !values['config.entity']) throw new Error('Bitte den Bereich der Datensatz-Auswahl festlegen.');
                        if (type === 'select' && (!original || 'optionsText' in payload)) {
                            payload.config.options = String(values.optionsText || '').split('\n').filter(line => line.trim()).map(line => {
                                const split = line.indexOf('=');
                                if (split < 1) throw new Error('Auswahlwerte als Schlüssel = Beschriftung eingeben.');
                                const value = line.slice(0, split).trim(); const name = line.slice(split + 1).trim();
                                if (!name) throw new Error('Jeder Auswahlwert benötigt eine Beschriftung.');
                                return { value, label: { ...original?.config?.options?.find(option => option.value === value)?.label, 'de-DE': name } };
                            });
                            if (!payload.config.options.length || new Set(payload.config.options.map(option => option.value)).size !== payload.config.options.length) throw new Error('Mindestens ein Auswahlwert; Schlüssel müssen eindeutig sein.');
                        }
                    }
                    delete payload.inputType; delete payload.optionsText; delete payload.multiple; return payload;
                },
            };
            const panel = entityListView(api, config, definition); panel.setTitle('Felder'); tabs.push(panel);
        }
        return tabs;
    },
};
