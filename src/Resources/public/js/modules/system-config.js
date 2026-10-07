import { entityField } from '../entity-fields.js';
import { fieldValue } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';
import { captchaField } from './captcha.js';

const domains = [
    ['basicInformation', 'Stammdaten'], ['cart', 'Warenkorb'], ['loginRegistration', 'Login / Registrierung'],
    ['listing', 'Produkte & Suche'], ['seo', 'SEO-Einstellungen'], ['newsletter', 'Newsletter-Einstellungen'],
    ['mailerSettings', 'E-Mail-Versand'], ['systemWideLoginRegistration', 'Kundenkonten & Anmeldung'], ['userPermission', 'Benutzereinstellungen'],
    ['media', 'Medieneinstellungen'], ['sitemap', 'Sitemap'], ['privacy', 'Datenschutz'],
];
export const systemConfigModules = domains.map(([domain, title]) => ({
    id: `config-${domain}`, title, entity: 'system_config', group: 'Shop-Einstellungen', icon: 'x-fa fa-cog',
    view: api => configView(api, `core.${domain}`),
}));

const label = value => typeof value === 'string' ? value : value?.['de-DE'] || value?.['en-GB'] || '';

function descriptor(element) {
    const config = element.config || {};
    const field = { name: element.name, label: label(config.label) || element.name,
        required: Boolean(config.required), default: config.defaultValue,
        min: config.min, max: config.max, maxLength: config.maxLength };
    if (config.componentName === 'sw-settings-captcha-select-v2') return { ...field, type: 'json', captcha: true };
    if (config.componentName === 'sw-media-field') return { ...field, type: 'reference', reference: { entity: 'media', labelFields: ['fileName'] } };
    if (config.entity) return { ...field, type: 'reference', multiple: config.componentName?.includes('multi') || false, reference: { entity: config.entity,
        ...(config.pageType ? { filter: [{ type: 'equals', field: 'type', value: config.pageType }] } : {}) } };
    const types = { bool: 'boolean', int: 'integer', float: 'number', text: 'text', password: 'password',
        textarea: 'textarea', 'text-editor': 'textarea', 'single-select': 'select', date: 'date', colorpicker: 'text' };
    if (element.type === 'multi-select' || config.componentName === 'sw-multi-select') return { ...field, type: 'multiselect', options: (config.options || []).map(option => [option.id ?? option.value, label(option.name || option.label)]) };
    if (!types[element.type]) return { ...field, type: 'json', label: `${field.label} (JSON)` };
    return { ...field, type: types[element.type], ...(element.type === 'single-select'
        ? { options: (config.options || []).map(option => [option.id, label(option.name)]) } : {}) };
}

export function configView(api, domain) {
    const canWrite = ['update', 'create', 'delete'].every(action => api.can(`system_config:${action}`));
    const scope = entityField(api, { name: 'salesChannel', label: 'Verkaufskanal (leer = global)', type: 'reference',
        reference: { entity: 'sales_channel' } }, null, true);
    scope.setWidth(380);
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, border: false });
    let currentScope = null;
    let requestId = 0;
    let saving = false;
    let entries = [];
    const panel = Ext.create('Ext.panel.Panel', {
        layout: 'fit', border: false, items: [form],
        tbar: [scope, '->', { text: 'Neu laden', handler: () => changeScope(currentScope) }],
        bbar: ['->', { text: 'Speichern', cls: 'emz-admin__primary', disabled: !canWrite, handler: save }],
        listeners: { afterrender: () => load() },
    });
    scope.on('select', () => changeScope(scope.getValue() || null));
    scope.on('change', (field, value) => { if (!value && currentScope) changeScope(null); });

    function changeScope(next) {
        if (saving) { scope.setValue(currentScope); return; }
        if (!form.getForm().isDirty()) { currentScope = next; load(); return; }
        Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Einstellungen gehen verloren.', choice => {
            if (choice === 'yes') { currentScope = next; load(); }
            else scope.setValue(currentScope);
        });
    }

    async function load() {
        const current = ++requestId;
        panel.setLoading('Einstellungen werden geladen …');
        try {
            const query = new URLSearchParams({ domain, ...(currentScope ? { salesChannelId: currentScope } : {}) });
            const [schema, values, inherited] = await Promise.all([
                api.request(`/_action/system-config/schema?domain=${encodeURIComponent(domain)}`),
                api.request(`/_action/system-config?${query}`),
                currentScope ? api.request(`/_action/system-config?domain=${encodeURIComponent(domain)}`) : Promise.resolve({}),
            ]);
            if (panel.destroyed || current !== requestId) return;
            form.removeAll(true);
            entries = [];
            for (const card of schema) {
                const items = [];
                for (const element of card.elements || []) {
                    const config = descriptor(element);
                    const own = Object.hasOwn(values, element.name);
                    const initial = own ? values[element.name] : inherited[element.name] ?? config.default;
                    const component = config.captcha ? await captchaField(api, config, initial, canWrite && (!currentScope || own))
                        : entityField(api, config, initial, canWrite && (!currentScope || own));
                    if (panel.destroyed || current !== requestId) { if (component.isComponent) component.destroy(); return; }
                    const field = component.isComponent ? component : Ext.widget(component.xtype, component);
                    let inherit;
                    if (currentScope) {
                        inherit = Ext.create('Ext.form.field.Checkbox', { boxLabel: `Globalen Wert verwenden: ${encode(config.label)}`, checked: !own, disabled: !canWrite,
                            listeners: { change: (checkbox, checked) => field.setReadOnly(!canWrite || checked) } });
                        items.push(inherit);
                    }
                    items.push(field);
                    entries.push({ descriptor: config, field, inherit });
                }
                form.add({ xtype: 'fieldset', title: encode(label(card.title)), items });
            }
            form.getForm().getFields().each(field => field.resetOriginalValue());
        } catch (error) { if (!panel.destroyed && api.user && current === requestId) showError(error); }
        finally { if (!panel.destroyed && current === requestId) panel.setLoading(false); }
    }

    async function save() {
        if (saving || !canWrite || !form.getForm().isValid()) return;
        saving = true;
        panel.setLoading('Einstellungen werden gespeichert …');
        try {
            const payload = {};
            for (const { descriptor, field, inherit } of entries) {
                if (!field.isDirty() && !inherit?.isDirty()) continue;
                payload[descriptor.name] = inherit?.getValue() ? null : fieldValue(descriptor, field.getValue());
            }
            if (!Object.keys(payload).length) return;
            const key = currentScope || 'null';
            await api.request('/_action/system-config/batch', 'POST', { [key]: payload });
            if (!panel.destroyed) { form.getForm().getFields().each(field => field.resetOriginalValue()); notify('Einstellungen gespeichert.'); }
        } catch (error) { if (!panel.destroyed && api.user) showError(error); }
        finally { saving = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    return panel;
}
