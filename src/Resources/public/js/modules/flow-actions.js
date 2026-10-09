import { entityField } from '../entity-fields.js';
import { customFieldDescriptor } from '../record-content.js';

const field = (name, label, extra = {}) => ({ name: `config.${name}`, label, ...extra });
const localLabel = value => typeof value === 'string' ? value : value?.['de-DE'] || value?.['en-GB'] || Object.values(value || {})[0] || '';
const customEntities = {
    'action.set.order.custom.field': 'order', 'action.set.customer.custom.field': 'customer', 'action.set.customer.group.custom.field': 'customer_group',
};
export const additionalActions = {
    'action.set.order.state': { label: 'Bestell-, Zahlungs- oder Lieferstatus ändern' },
    'action.generate.document': { label: 'Dokumente erzeugen' },
    'action.set.order.custom.field': { label: 'Bestellungs-Zusatzfeld ändern' },
    'action.set.customer.custom.field': { label: 'Kunden-Zusatzfeld ändern' },
    'action.set.customer.group.custom.field': { label: 'Kundengruppen-Zusatzfeld ändern' },
};

export async function flowActionFields(api, action, original, standard) {
    if (action === 'action.set.order.state') {
        const response = await api.search('state-machine-state', { limit: 500, associations: { stateMachine: {} } });
        return { fields: [
            ...[['order', 'Bestellstatus'], ['order_transaction', 'Zahlungsstatus'], ['order_delivery', 'Lieferstatus']].map(([machine, label]) => field(machine, label, { type: 'select',
                options: [['', 'Keine Änderung'], ...response.data.filter(state => state.stateMachine?.technicalName === `${machine}.state`).map(state => [state.technicalName, state.name])] })),
            field('force_transition', 'Statuswechsel auch außerhalb der erlaubten Übergänge erzwingen', { type: 'boolean' }),
        ] };
    }
    if (action === 'action.generate.document') {
        const response = await api.search('document-type', { limit: 100, filter: [{ type: 'not', operator: 'AND', queries: [{ type: 'equals', field: 'technicalName', value: 'app_provided' }] }] });
        return { fields: [field('documentTypes', 'Dokumenttypen', { type: 'multiselect', required: true,
            options: response.data.map(type => [type.technicalName, type.name]),
            initialValue: record => record.config?.documentTypes?.map(type => type.documentType) || (record.config?.documentType ? [record.config.documentType] : []) })] };
    }
    if (customEntities[action]) {
        const entity = original?.config?.entity || customEntities[action];
        const id = original?.config?.customFieldId || await chooseCustomField(api, entity);
        if (!id) return null;
        const custom = (await api.search('custom-field', { ids: [id], limit: 1 })).data[0];
        if (!custom) throw new Error('Das Zusatzfeld ist nicht mehr vorhanden.');
        const descriptor = customFieldDescriptor(custom);
        const options = [['upsert', 'Setzen oder überschreiben'], ['create', 'Nur setzen, wenn leer'], ['clear', 'Wert entfernen']];
        if (descriptor.multiple || descriptor.type === 'multiselect') options.push(['add', 'Werte hinzufügen'], ['remove', 'Werte entfernen']);
        return { defaults: { config: { entity, customFieldId: id, customFieldSetId: custom.customFieldSetId, customFieldLabel: descriptor.label } },
            fields: [field('customFieldLabel', 'Zusatzfeld', { readOnly: true, default: descriptor.label }),
                field('option', 'Änderung', { type: 'select', required: true, default: 'upsert', options }), { ...descriptor, name: 'config.customFieldValue', label: 'Wert' }] };
    }
    if (standard) return { fields: standard.map(field => ({ ...field })) };
    if (api.can('app_flow_action:read')) {
        const response = await api.search('app-flow-action', { limit: 1, filter: [{ type: 'equals', field: 'name', value: action }], associations: { app: {} } });
        const app = response.data[0];
        if (app) return { defaults: { appFlowActionId: app.id }, fields: (app.config || []).map(config => {
            const types = { int: 'integer', float: 'number', bool: 'boolean', checkbox: 'boolean', text: 'text', textarea: 'textarea', password: 'password', email: 'email', url: 'text', date: 'date', datetime: 'datetime', 'single-select': 'select', 'multi-select': 'multiselect', colorpicker: 'text' };
            return field(config.name, localLabel(config.label) || config.name, { type: types[config.type] || 'json', required: config.required, default: config.defaultValue,
                readOnly: !app.app?.active, ...(config.options ? { options: config.options.map(option => [option.value ?? option.id, localLabel(option.label || option.name)]) } : {}),
                initialValue: record => record.config?.[config.name]?.value ?? record.config?.[config.name] ?? config.defaultValue });
        }) };
    }
    return { fields: [{ name: 'config', label: 'Aktionskonfiguration (JSON)', type: 'json' }] };
}

export function prepareFlowAction(action, payload, original, values) {
    if (payload.config?.tagIds && Array.isArray(payload.config.tagIds)) payload.config.tagIds = Object.fromEntries(payload.config.tagIds.map(tag => [tag, tag]));
    if (action === 'action.generate.document' && payload.config?.documentTypes) {
        const previous = original?.config?.documentTypes || (original?.config?.documentType ? [original.config] : []);
        payload.config.documentTypes = payload.config.documentTypes.map(type => ({ ...previous.find(item => item.documentType === type), documentType: type, documentRangerType: `document_${type}` }));
        delete payload.config.documentType; delete payload.config.documentRangerType;
    }
    if (action === 'action.set.order.state' && !['order', 'order_transaction', 'order_delivery'].some(key => values[`config.${key}`])) throw new Error('Bitte mindestens einen Zielstatus wählen.');
    if (action === 'action.mail.send') {
        if (Array.isArray(payload.config?.recipient?.data)) payload.config.recipient.data = Object.fromEntries(payload.config.recipient.data.map(line => {
            const [email, ...name] = line.split(';'); const input = document.createElement('input'); input.type = 'email'; input.value = email.trim();
            if (!input.value || !input.checkValidity()) throw new Error('Bitte gültige Empfänger im Format E-Mail;Name eintragen.');
            return [input.value, name.join(';').trim() || input.value];
        }));
        const recipient = { ...original?.config?.recipient, ...payload.config?.recipient };
        if (recipient.type === 'custom' && !Object.keys(recipient.data || {}).length) throw new Error('Bitte mindestens einen eigenen E-Mail-Empfänger angeben.');
    }
    return payload;
}

function chooseCustomField(api, entity) {
    return new Promise(resolve => {
        let completed = false;
        const select = entityField(api, { name: 'customFieldId', label: 'Zusatzfeld', type: 'reference', required: true,
            reference: { entity: 'custom_field', filter: [{ type: 'equals', field: 'customFieldSet.relations.entityName', value: entity }, { type: 'equals', field: 'active', value: true }] } }, null, true);
        const dialog = Ext.create('Ext.window.Window', { title: 'Zusatzfeld auswählen', modal: true, constrain: true, width: Math.min(520, innerWidth - 24), bodyPadding: 20, layout: 'anchor', items: [select],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Weiter', cls: 'emz-admin__primary', handler: () => {
                if (!select.isValid()) return; const value = select.getValue(); completed = true; dialog.destroy(); resolve(value);
            } }], listeners: { destroy: () => { if (!completed) resolve(null); } },
        }); dialog.show();
    });
}
