import { entityField } from '../entity-fields.js';
import { entityListView } from '../entity-list.js';
import { fieldValue } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';
import { themeLabels } from './theme-labels.js';

const label = value => typeof value === 'string' ? value : value?.['de-DE'] || value?.['en-GB'] || '';

export const themeModule = {
    id: 'themes', title: 'Themes', singular: 'Theme-Kopie', entity: 'theme', group: 'Inhalte', icon: 'x-fa fa-paint-brush',
    search: ['name', 'author'], sort: 'name', direction: 'ASC', editorWidth: 1020, associations: { salesChannels: { limit: 1 } }, editAssociations: { salesChannels: { limit: 1 } },
    isDeleteLocked: record => Boolean(record?.technicalName || record?.salesChannels?.length),
    defaults: { active: true, author: '8mylez', baseConfig: null, configValues: null },
    columns: [{ field: 'name', label: 'Theme' }, { field: 'author', label: 'Autor' }, { field: 'active', label: 'Verfügbar', type: 'boolean', width: 120 }],
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'author', label: 'Autor', required: true },
        { name: 'parentThemeId', label: 'Basis-Theme', required: true, type: 'reference', reference: { entity: 'theme', filter: [{ type: 'equals', field: 'active', value: true }] }, createOnly: true },
        { name: 'description', label: 'Beschreibung', type: 'textarea' }],
    detailTabs: (api, config, theme) => {
        const tabs = [themeConfigPanel(api, theme)];
        if (api.can('sales_channel:read')) {
            const panel = entityListView(api, config, { title: 'Zugeordnete Verkaufskanäle', singular: 'Verkaufskanal', entity: 'sales_channel', create: false, delete: false,
                search: ['name'], sort: 'name', direction: 'ASC', filter: [{ type: 'equals', field: 'themes.id', value: theme.id }],
                fields: [{ name: 'name', label: 'Name', readOnly: true }], columns: [{ field: 'name', label: 'Verkaufskanal' }, { field: 'active', label: 'Aktiv', type: 'boolean' }],
            }); panel.setTitle('Verkaufskanäle'); tabs.push(panel);
        }
        return tabs;
    },
};

function descriptor(name, field) {
    const custom = field.custom || {};
    const result = { name, label: label(field.label) || themeLabels[name] || name, min: custom.min, max: custom.max,
        required: Boolean(custom.required), readOnly: field.editable === false };
    if (field.type === 'media') return { ...result, type: 'reference', reference: { entity: 'media', labelFields: ['fileName'] } };
    if (custom.entity) return { ...result, type: 'reference', reference: { entity: custom.entity }, multiple: custom.componentName?.includes('multi') };
    if (custom.options || field.options) return { ...result, type: custom.componentName?.includes('multi') ? 'multiselect' : 'select',
        options: (custom.options || field.options).map(option => [option.value ?? option.id, label(option.label || option.name) || String(option.value ?? option.id)]) };
    const types = { color: 'text', fontFamily: 'text', text: 'text', textarea: 'textarea', url: 'text', number: 'number', int: 'integer', float: 'number',
        checkbox: 'boolean', switch: 'boolean', boolean: 'boolean', bool: 'boolean' };
    return { ...result, type: types[field.type] || (typeof field.value === 'object' ? 'json' : 'text') };
}

function themeConfigPanel(api, theme) {
    let entries = []; let loading = false; let saving = false;
    const writable = api.can('theme:update');
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, border: false });
    const panel = Ext.create('Ext.panel.Panel', { title: 'Theme-Konfiguration', layout: 'fit', items: [form],
        bbar: [{ xtype: 'tbtext', text: 'Änderungen gelten für alle diesem Theme zugeordneten Verkaufskanäle.' }, '->',
            { text: 'Theme-Konfiguration speichern', disabled: !writable, handler: save }], listeners: { afterrender: load },
    }); panel.hasUnsavedChanges = () => saving || (!loading && form.getForm().isDirty());
    async function load() {
        loading = true; panel.setLoading('Theme-Konfiguration wird geladen …');
        try {
            const data = await api.request(`/_action/theme/${theme.id}/configuration`);
            if (panel.destroyed) return;
            form.removeAll(true); entries = []; const groups = new Map();
            for (const [name, setting] of Object.entries(data.fields || {}).sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))) {
                if (!setting.type) continue;
                const description = descriptor(name, setting); const current = data.currentFields?.[name];
                const value = current?.isInherited ? setting.value : current?.value ?? setting.value;
                const control = entityField(api, description, value, writable && !current?.isInherited);
                const field = control.isComponent ? control : Ext.widget(control);
                const inherit = Ext.create('Ext.form.field.Checkbox', { boxLabel: `Vorgabe verwenden: ${description.label}`, checked: Boolean(current?.isInherited), disabled: !writable || description.readOnly,
                    listeners: { change: (checkbox, checked) => field.setReadOnly(!writable || description.readOnly || checked) } });
                const group = setting.block || 'Allgemein';
                if (!groups.has(group)) groups.set(group, []);
                groups.get(group).push(field, inherit);
                if (setting.helpText) groups.get(group).push({ xtype: 'component', html: `<p>${encode(label(setting.helpText))}</p>` });
                entries.push({ name, field, inherit, descriptor: description });
            }
            for (const [name, items] of groups) form.add({ xtype: 'fieldset', title: encode(label(data.blocks?.[name]?.label) || themeLabels[name] || name), items });
            form.getForm().getFields().each(field => field.resetOriginalValue());
        } catch (error) { if (!panel.destroyed && api.user) showError(error); }
        finally { loading = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    async function save() {
        if (saving || loading || !writable || !form.getForm().isValid()) return;
        if (!entries.some(entry => entry.field.isDirty() || entry.inherit.isDirty())) return;
        saving = true; panel.setLoading('Theme wird gespeichert und neu kompiliert …');
        try {
            const current = (await api.search('theme', { ids: [theme.id], limit: 1 })).data[0];
            const values = { ...current.configValues };
            for (const entry of entries) {
                if (!entry.field.isDirty() && !entry.inherit.isDirty()) continue;
                if (entry.inherit.getValue()) delete values[entry.name];
                else values[entry.name] = { value: fieldValue(entry.descriptor, entry.field.getValue()) };
            }
            await api.request(`/_action/theme/${theme.id}?reset=true&validate=true`, 'PATCH', { config: values });
            if (!panel.destroyed) { await load(); notify('Theme-Konfiguration gespeichert. Zugeordnete Verkaufskanäle werden neu kompiliert.'); }
        } catch (error) { if (!panel.destroyed && api.user) showError(error); }
        finally { saving = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    return panel;
}

export function channelThemePanel(api, channel) {
    let busy = false;
    const select = entityField(api, { name: 'themeId', label: 'Theme', type: 'reference', required: true, reference: { entity: 'theme', filter: [{ type: 'equals', field: 'active', value: true }] } }, null, true);
    const panel = Ext.create('Ext.panel.Panel', { title: 'Theme', bodyPadding: 20, layout: 'anchor', items: [
        { xtype: 'component', itemId: 'current', html: '<p>Aktuelles Theme wird geladen …</p>' }, select,
        { xtype: 'button', text: 'Theme zuweisen', disabled: !api.can('theme:update') || !api.can('sales_channel:update'), handler: () => {
            if (busy || !select.isValid()) return;
            Ext.Msg.confirm('Theme zuweisen?', 'Das gewählte Theme wird kompiliert und anschließend für diesen Verkaufskanal verwendet.', async choice => {
                if (choice !== 'yes' || panel.destroyed || busy) return;
                busy = true; panel.setLoading('Theme wird zugewiesen …');
                try { await api.request(`/_action/theme/${select.getValue()}/assign/${channel.id}`, 'POST', {}); await load(); notify('Theme-Zuweisung angefordert. Die Ansicht nach Abschluss der Kompilierung aktualisieren.'); }
                catch (error) { if (api.user) showError(error); }
                finally { busy = false; if (!panel.destroyed) panel.setLoading(false); }
            });
        } }, { xtype: 'button', text: 'Zuweisung aktualisieren', handler: load },
    ], listeners: { afterrender: load } });
    async function load() {
        try {
            const result = await api.search('theme', { limit: 1, filter: [{ type: 'equals', field: 'salesChannels.id', value: channel.id }] });
            if (!panel.destroyed) panel.down('#current').update(`<p>Aktuelles Theme: ${encode(result.data[0]?.name || 'Keines zugewiesen')}</p>`);
        } catch (error) { if (!panel.destroyed && api.user) showError(error); }
    }
    return panel;
}
