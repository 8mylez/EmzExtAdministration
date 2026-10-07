import { entityPath, recordLabel, fieldValue } from './entity-data.js';
import { encode, showError } from './ui.js';

export function entityField(api, descriptor, initialValue, writable) {
    const base = {
        name: descriptor.name, fieldLabel: encode(descriptor.label), labelAlign: 'top', anchor: '100%',
        readOnly: !writable || descriptor.readOnly, allowBlank: !descriptor.required,
        value: initialValue ?? descriptor.default ?? '',
        ...(descriptor.maxLength ? { maxLength: descriptor.maxLength, enforceMaxLength: true } : {}),
    };
    if (descriptor.type === 'reference') return referenceField(api, descriptor, base);
    if (descriptor.type === 'boolean') return { ...base, xtype: 'checkboxfield', checked: Boolean(initialValue ?? descriptor.default), inputValue: true };
    if (['number', 'integer'].includes(descriptor.type)) {
        return { ...base, xtype: 'numberfield', allowDecimals: descriptor.type !== 'integer',
            decimalPrecision: descriptor.precision ?? 8, minValue: descriptor.min, maxValue: descriptor.max,
            value: initialValue ?? descriptor.default ?? null };
    }
    if (descriptor.type === 'select' || descriptor.type === 'multiselect') return { ...base, xtype: descriptor.type === 'multiselect' ? 'tagfield' : 'combobox', queryMode: 'local',
        ...(descriptor.type === 'multiselect' ? { ariaLabel: descriptor.label } : {}),
        editable: descriptor.type === 'multiselect', forceSelection: true, collapseOnSelect: true, displayField: 'label', valueField: 'value',
        store: { fields: ['value', 'label'], data: descriptor.options.map(([value, label]) => ({ value, label })) },
        labelTpl: '{label:htmlEncode}', listConfig: { getInnerTpl: () => '{label:htmlEncode}' }, value: initialValue ?? descriptor.default ?? null };
    if (descriptor.type === 'date') return { ...base, xtype: 'datefield', format: 'd.m.Y',
        value: initialValue ? descriptor.dateOnly ? new Date(`${String(initialValue).slice(0, 10)}T00:00:00`) : new Date(initialValue) : null };
    if (descriptor.type === 'datetime') {
        const date = initialValue ? new Date(initialValue) : null;
        const value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19) : '';
        return { ...base, xtype: 'textfield', inputType: 'datetime-local', inputAttrTpl: 'step="1"', value,
            validator: input => !input || !Number.isNaN(new Date(input).getTime()) || 'Bitte Datum und Uhrzeit eingeben.' };
    }
    if (descriptor.type === 'json') return { ...base, xtype: 'textareafield', height: descriptor.height || 180,
        value: initialValue === undefined || initialValue === null ? '' : JSON.stringify(initialValue, null, 2), validator: value => {
            try { if (value.trim()) JSON.parse(value); return true; } catch { return 'Bitte gültiges JSON eingeben.'; }
        } };
    if (descriptor.type === 'textarea' || descriptor.type === 'lines') return { ...base, xtype: 'textareafield', height: descriptor.height || 120,
        value: descriptor.type === 'lines' && Array.isArray(base.value) ? base.value.join('\n') : base.value };
    return { ...base, xtype: 'textfield', inputType: ['password', 'email'].includes(descriptor.type) ? descriptor.type : 'text',
        ...(descriptor.type === 'email' ? { validator: value => {
            if (!value) return true;
            const input = document.createElement('input');
            input.type = 'email';
            input.value = value.trim();
            return input.checkValidity() || 'Bitte eine gültige E-Mail-Adresse eingeben.';
        } } : {}) };
}

function referenceField(api, descriptor, base) {
    const reference = descriptor.reference;
    const allowed = api.can(`${reference.entity}:read`);
    const initialIds = descriptor.multiple ? (Array.isArray(base.value) ? base.value : []) : base.value ? [base.value] : [];
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'label'],
        data: initialIds.map(id => ({ id, label: id })) });
    let requestId = 0;
    const field = Ext.create(descriptor.multiple ? 'Ext.form.field.Tag' : 'Ext.form.field.ComboBox', {
        ...base, readOnly: base.readOnly || !allowed, store, displayField: 'label', valueField: 'id',
        ...(descriptor.multiple ? { ariaLabel: descriptor.label } : {}),
        labelTpl: '{label:htmlEncode}',
        queryMode: 'local', forceSelection: true, collapseOnSelect: true, minChars: 0, queryDelay: 300,
        emptyText: allowed ? 'Tippen zum Suchen …' : 'Keine Leseberechtigung',
        listConfig: { emptyText: 'Keine Treffer. Suche verfeinern.', getInnerTpl: () => '{label:htmlEncode}' },
        ...(descriptor.required ? {} : { triggers: { clear: { cls: 'x-form-clear-trigger', handler: () => field.clearValue() } } }),
        listeners: {
            beforequery: query => { query.cancel = true; if (allowed) load(query.forceAll ? '' : query.query); },
            afterrender: () => { if (allowed && initialIds.length) load('', initialIds); },
            destroy: () => store.destroy(),
        },
    });
    async function load(term, selectedIds) {
        const current = ++requestId;
        const rawAtStart = field.getRawValue();
        try {
            const response = await api.search(entityPath(reference.entity), {
                limit: selectedIds ? Math.min(selectedIds.length, 500) : 25, 'total-count-mode': 0,
                ...(reference.associations ? { associations: reference.associations } : {}),
                ...(selectedIds ? { ids: selectedIds } : {
                    filter: [...(reference.filter || []), ...(term ? [{ type: 'multi', operator: 'OR',
                        queries: (reference.search || reference.labelFields || ['name']).map(name => ({ type: 'contains', field: name, value: term })) }] : [])],
                }),
            });
            if (field.destroyed || current !== requestId) return;
            if (selectedIds && field.getRawValue() !== rawAtStart) return;
            const selected = (descriptor.multiple ? field.getValue() : [field.getValue()]).map(id => store.getById(id)).filter(Boolean);
            const items = response.data.map(record => ({ id: record.id, label: recordLabel(record, reference) }));
            for (const record of selected) if (!items.some(item => item.id === record.id)) items.push(record.data);
            store.loadData(items);
            if (selectedIds) {
                field.setValue(descriptor.multiple ? selectedIds : selectedIds[0]);
                field.resetOriginalValue();
            } else {
                field.expand();
            }
        } catch (error) {
            if (!field.destroyed && api.user && current === requestId) showError(error);
        }
    }
    return field;
}

export function formValues(form, fields) {
    const values = {};
    const dirty = new Set();
    for (const descriptor of fields) {
        const field = form.getForm().findField(descriptor.name);
        if (!field) continue;
        values[descriptor.name] = fieldValue(descriptor, field.getValue());
        if (field.isDirty()) dirty.add(descriptor.name);
    }
    return { values, dirty };
}

export function errorHtml(error) {
    return encode(error.message).replaceAll('\n', '<br>');
}
