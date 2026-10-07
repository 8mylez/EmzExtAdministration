import { entityField, formValues } from './entity-fields.js';
import { entityPath, entityPayload } from './entity-data.js';
import { encode, notify } from './ui.js';

const schemas = new WeakMap();
const label = value => typeof value === 'string' ? value : value?.['de-DE'] || value?.['en-GB'] || Object.values(value || {})[0] || '';

export async function recordContentTabs(api, config, definition, record) {
    if (!api.can('language:read') && !api.can('custom_field_set:read')) return [];
    if (!schemas.has(api)) schemas.set(api, api.request('/_info/entity-schema.json').catch(error => { schemas.delete(api); throw error; }));
    const schema = (await schemas.get(api))[definition.entity]?.properties || {};
    const fields = definition.fields.filter(field => schema[field.translationSource || field.name]?.flags?.translatable && !field.readOnly && !field.createOnly);
    const tabs = [];
    const locked = Boolean(definition.isLocked?.(record));
    if (fields.length && api.can('language:read')) tabs.push(translationsPanel(api, config, definition, record.id, fields, locked));
    if (schema.customFields && api.can('custom_field_set:read') && api.can('custom_field:read')) tabs.push(customFieldsPanel(api, config, definition, record.id, locked));
    return tabs;
}

function translationsPanel(api, config, definition, id, fields, locked) {
    let currentLanguage;
    let original;
    let saving = false;
    let loading = false;
    let sequence = 0;
    const writable = api.can(`${definition.entity}:update`) && !locked;
    const language = entityField(api, { name: 'translationLanguage', label: 'Sprache', type: 'reference', required: true, reference: { entity: 'language' } }, config.languageId, true);
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, border: false });
    const panel = Ext.create('Ext.panel.Panel', { title: 'Übersetzungen', layout: 'fit', items: [form],
        tbar: [language, { text: 'Übersetzung laden', handler: changeLanguage }],
        bbar: [{ text: 'Übersetzung speichern', disabled: !writable, handler: save }],
        listeners: { afterrender: changeLanguage },
    });
    async function changeLanguage() {
        if (saving || !language.getValue()) return;
        if (form.getForm().isDirty()) {
            Ext.Msg.confirm('Übersetzung verwerfen?', 'Die ungespeicherten Texte werden verworfen.', choice => { if (choice === 'yes') load(); });
        } else await load();
    }
    async function load() {
        const current = ++sequence;
        const selected = language.getValue();
        loading = true; panel.setLoading('Übersetzung wird geladen …');
        try {
            const response = await api.search(entityPath(definition.entity), { ids: [id], limit: 1 }, { headers: { 'sw-language-id': selected } });
            if (panel.destroyed || current !== sequence) return;
            original = response.data[0];
            if (!original) throw new Error('Der Datensatz ist nicht mehr vorhanden.');
            currentLanguage = selected;
            form.removeAll();
            form.add({ xtype: 'component', html: '<p>Die Texte werden ausschließlich in der ausgewählten Sprache gespeichert. Leere Übersetzungen übernehmen den Sprach-Fallback, soweit das Feld dies erlaubt.</p>' });
            form.add(fields.map(field => entityField(api, { ...field, required: currentLanguage === config.languageId && field.required },
                field.translationValue ? field.translationValue(original) : original[field.name], writable)));
            form.add({ xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' });
            form.getForm().getFields().each(field => field.resetOriginalValue());
        } catch (error) { if (!panel.destroyed && api.user) { form.removeAll(); form.add({ xtype: 'component', html: encode(error.message), ariaRole: 'alert' }); } }
        finally { if (!panel.destroyed && current === sequence) { loading = false; panel.setLoading(false); } }
    }
    async function save() {
        if (saving || loading || !original || !writable || !form.getForm().isValid()) return;
        saving = true; panel.setLoading('Übersetzung wird gespeichert …');
        try {
            const { values, dirty } = formValues(form, fields);
            const translatedFields = fields.map(field => ({ ...field, required: currentLanguage === config.languageId && field.required }));
            let payload = entityPayload({ fields: translatedFields }, values, original, dirty);
            if (definition.prepareTranslation) payload = await definition.prepareTranslation(payload, original, { api, config, values });
            for (const key of Object.keys(payload)) if (payload[key] === '' && currentLanguage !== config.languageId) payload[key] = null;
            if (Object.keys(payload).length) await api.request(`/${entityPath(definition.entity)}/${id}`, 'PATCH', payload, { headers: { 'sw-language-id': currentLanguage } });
            if (!panel.destroyed) { form.getForm().getFields().each(field => field.resetOriginalValue()); notify('Übersetzung gespeichert.'); }
        } catch (error) { if (!panel.destroyed && api.user) form.down('#error')?.update(encode(error.message)); }
        finally { saving = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    panel.hasUnsavedChanges = () => saving || form.getForm().isDirty();
    return panel;
}

export function customFieldDescriptor(field) {
    const settings = field.config || {};
    const base = { name: field.name, label: label(settings.label) || field.name };
    if (settings.entity) return { ...base, type: 'reference', multiple: settings.componentName === 'sw-entity-multi-id-select',
        reference: { entity: settings.entity, labelFields: [settings.labelProperty || (settings.entity === 'customer' ? 'email' : 'name')] } };
    if (field.type === 'media' || settings.componentName === 'sw-media-field') return { ...base, type: 'reference', reference: { entity: 'media', labelFields: ['fileName'] } };
    if (['select', 'json'].includes(field.type) && Array.isArray(settings.options)) return { ...base,
        type: settings.componentName === 'sw-multi-select' ? 'multiselect' : 'select', options: settings.options.map(option => [option.value, label(option.label) || option.value]) };
    const types = { bool: 'boolean', checkbox: 'boolean', switch: 'boolean', float: 'number', number: 'number', int: 'integer', json: 'json',
        date: 'date', datetime: 'datetime', html: 'textarea', text: settings.componentName === 'sw-textarea-field' ? 'textarea' : 'text', colorpicker: 'text' };
    if (types[field.type]) return { ...base, type: types[field.type], ...(field.type === 'date' ? { dateOnly: true } : {}) };
    return { ...base, type: 'textarea', readOnly: true, unsupported: true };
}

function customFieldsPanel(api, config, definition, id, locked) {
    const writable = api.can(`${definition.entity}:update`) && !locked;
    const form = Ext.create('Ext.form.Panel', { title: 'Zusatzfelder', bodyPadding: 20, scrollable: true,
        bbar: [{ text: 'Zusatzfelder speichern', disabled: !writable, handler: save }], listeners: { afterrender: load } });
    let descriptors = [];
    let original;
    let saving = false;
    async function load() {
        form.setLoading('Zusatzfelder werden geladen …');
        try {
            const response = await api.search('custom-field-set', { limit: 500, filter: [
                { type: 'equals', field: 'relations.entityName', value: definition.entity }, { type: 'equals', field: 'active', value: true },
                ...(definition.entity === 'product' ? [{ type: 'multi', operator: 'OR', queries: [
                    { type: 'equals', field: 'global', value: true }, { type: 'equals', field: 'products.id', value: id },
                ] }] : []),
            ], associations: { customFields: { limit: 500, filter: [{ type: 'equals', field: 'active', value: true }], sort: [{ field: 'config.customFieldPosition', order: 'ASC' }] } } });
            original = (await api.search(entityPath(definition.entity), { ids: [id], limit: 1 })).data[0];
            if (form.destroyed || !api.user) return;
            if (!original) throw new Error('Der Datensatz ist nicht mehr vorhanden.');
            for (const set of response.data) {
                const fields = set.customFields.map(customFieldDescriptor);
                descriptors.push(...fields);
                form.add({ xtype: 'fieldset', title: encode(label(set.config?.label) || set.name), items: fields.map(field => {
                    const value = original.customFields?.[field.name];
                    return entityField(api, field, field.unsupported ? JSON.stringify(value ?? null, null, 2) : value, writable);
                }) });
            }
            if (!descriptors.length) form.add({ xtype: 'component', html: '<p>Für diesen Bereich sind keine aktiven Zusatzfelder definiert.</p>' });
            form.add({ xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' });
            form.getForm().getFields().each(field => field.resetOriginalValue());
        } catch (error) { if (!form.destroyed && api.user) form.add({ xtype: 'component', html: encode(error.message), ariaRole: 'alert' }); }
        finally { if (!form.destroyed) form.setLoading(false); }
    }
    async function save() {
        if (saving || !original || !writable || !form.getForm().isValid()) return;
        saving = true; form.setLoading('Zusatzfelder werden gespeichert …');
        try {
            const { values, dirty } = formValues(form, descriptors);
            const changes = entityPayload({ fields: descriptors }, values, original.customFields || {}, dirty);
            if (Object.keys(changes).length) {
                // Shopware merges custom field keys; submit only edited keys, retaining plugin data.
                await api.request(`/${entityPath(definition.entity)}/${id}`, 'PATCH', { customFields: changes });
            }
            if (!form.destroyed) { form.getForm().getFields().each(field => field.resetOriginalValue()); notify('Zusatzfelder gespeichert.'); }
        } catch (error) { if (!form.destroyed && api.user) form.down('#error')?.update(encode(error.message)); }
        finally { saving = false; if (!form.destroyed) form.setLoading(false); }
    }
    form.hasUnsavedChanges = () => saving || form.getForm().isDirty();
    return form;
}
