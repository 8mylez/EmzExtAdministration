import { fieldValue } from './entity-data.js';
import { replaceCurrencyPrice } from './price-data.js';
import { encode } from './ui.js';

export function resolvedProductValues(record) {
    if (!record) return record;
    const resolved = { ...record };
    for (const [name, value] of Object.entries(record.translated || {})) if (Object.hasOwn(record, name)) resolved[name] = value ?? record[name];
    return resolved;
}

export function applyProductInheritance(payload, inherited, own, values, fields, prices, currencyId) {
    for (const [name, enabled] of inherited) {
        if (enabled) {
            if (own[name] != null) payload[name] = null;
            else delete payload[name];
        } else if (own[name] == null) {
            payload[name] = name === 'price' ? replaceCurrencyPrice(prices, { currencyId, gross: values.gross, net: values.net, linked: values.linked })
                : fieldValue(fields.find(field => field.name === name) || { name }, values[name]);
        }
    }
    return payload;
}

export function productInheritanceControls(form, own, parent, descriptors, writable) {
    const controls = new Map();
    if (!own?.parentId) return controls;
    const basic = form.getForm();
    const names = [{ name: 'name', label: 'Produktname' }, { name: 'active', label: 'Status' }, { name: 'taxId', label: 'Steuersatz' },
        { name: 'price', label: 'Standardpreis' }, { name: 'description', label: 'Beschreibung' }, ...descriptors.filter(field => !field.createOnly && !field.readOnly)];
    for (const descriptor of names) {
        const name = descriptor.name;
        const fields = name === 'price' ? ['gross', 'net', 'linked'].map(name => basic.findField(name)) : [basic.findField(name)];
        if (fields.some(field => !field)) continue;
        const readonly = fields.map(field => field.readOnly);
        const checkbox = Ext.create('Ext.form.field.Checkbox', { name: `inherit-${name}`, boxLabel: `Vom Hauptprodukt übernehmen: ${encode(descriptor.label)}`,
            checked: own[name] == null, disabled: !writable || readonly.some(Boolean), listeners: { change: (box, inherited) => {
                for (const [index, field] of fields.entries()) {
                    field.setReadOnly(readonly[index] || inherited);
                    if (!inherited) continue;
                    if (name === 'price') field.setValue(parent.price?.find(price => price.currencyId === form.systemCurrencyId)?.[field.getName()]);
                    else if (descriptor.type === 'date') field.setValue(parent[name] ? new Date(parent[name]) : null);
                    else if (descriptor.type === 'lines') field.setValue((parent[name] || []).join('\n'));
                    else field.setValue(parent[name] ?? (descriptor.type === 'boolean' ? false : null));
                }
            } } });
        controls.set(name, checkbox);
        const container = fields[0].ownerCt; container.insert(container.items.indexOf(fields[0]), checkbox);
        if (own[name] == null) fields.forEach(field => field.setReadOnly(true));
    }
    return controls;
}
