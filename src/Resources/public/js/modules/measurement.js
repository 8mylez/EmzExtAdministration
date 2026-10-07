import { encode, notify, showError } from '../ui.js';

function measurementView(api, owner) {
    let systems = [];
    let loading = false;
    let saving = false;
    const writable = owner ? api.can(`${owner.entity}:update`) : ['update', 'create', 'delete'].every(action => api.can(`system_config:${action}`));
    const combo = (name, label) => ({ xtype: 'combobox', name, fieldLabel: label, labelAlign: 'top', anchor: '100%',
        queryMode: 'local', editable: false, forceSelection: true, allowBlank: false, readOnly: !writable,
        store: { fields: ['value', 'label'], data: [] }, valueField: 'value', displayField: 'label', listConfig: { getInnerTpl: () => '{label:htmlEncode}' } });
    const panel = Ext.create('Ext.form.Panel', { title: owner ? 'Maßsystem' : undefined, bodyPadding: 24, scrollable: true, items: [
        { xtype: 'component', html: '<p>Standardmaße für die Anzeige im Shop. Bestehende Produktmaße werden dadurch nicht umgerechnet.</p>' },
        combo('system', 'Maßsystem'), combo('length', 'Längeneinheit'), combo('weight', 'Gewichtseinheit'),
        { xtype: 'component', itemId: 'details' },
    ], bbar: ['->', { text: 'Maßsystem speichern', disabled: !writable, handler: save }], listeners: { afterrender: load } });
    const form = panel.getForm();
    form.findField('system').on('change', () => { if (!loading) update(); });
    function update(selected = {}) {
        const system = systems.find(system => system.technicalName === form.findField('system').getValue());
        for (const type of ['length', 'weight']) {
            const units = Object.values(system?.units || {}).filter(unit => unit.type === type);
            const field = form.findField(type);
            field.getStore().loadData(units.map(unit => ({ value: unit.shortName, label: `${unit.translated?.name || unit.name || unit.shortName} (${unit.shortName})` })));
            field.setValue(units.find(unit => unit.shortName === selected[type])?.shortName || units.find(unit => unit.default)?.shortName || units[0]?.shortName);
        }
        panel.down('#details').update(system ? `<p>${encode(system.translated?.name || system.name)}</p>` : '');
    }
    async function load() {
        loading = true; panel.setLoading('Maßsysteme werden geladen …');
        try {
            const current = owner ? (await api.search(owner.entity.replaceAll('_', '-'), { ids: [owner.id], limit: 1 })).data[0] : null;
            const values = owner ? { 'core.measurementUnits.system': current.measurementUnits.system,
                'core.measurementUnits.length': current.measurementUnits.units.length, 'core.measurementUnits.weight': current.measurementUnits.units.weight }
                : await api.request('/_action/system-config?domain=core.measurementUnits');
            systems = [];
            for (let page = 1; ; page++) {
                const result = await api.search('measurement-system', { page, limit: 100, associations: { units: { limit: 500 } } }); systems.push(...result.data);
                if (page * 100 >= result.total) break;
            }
            if (panel.destroyed) return;
            form.findField('system').getStore().loadData(systems.map(system => ({ value: system.technicalName, label: system.translated?.name || system.name || system.technicalName })));
            form.findField('system').setValue(values['core.measurementUnits.system']);
            update({ length: values['core.measurementUnits.length'], weight: values['core.measurementUnits.weight'] });
            form.getFields().each(field => field.resetOriginalValue());
        } catch (error) { if (api.user && !panel.destroyed) showError(error); }
        finally { loading = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    async function save() {
        if (!writable || saving || loading || !form.isValid()) return;
        saving = true; panel.setLoading('Maßsystem wird gespeichert …');
        try {
            const values = Object.fromEntries(['system', 'length', 'weight'].map(name => [`core.measurementUnits.${name}`, form.findField(name).getValue()]));
            if (owner) await api.request(`/${owner.entity.replaceAll('_', '-')}/${owner.id}`, 'PATCH', { measurementUnits: {
                system: values['core.measurementUnits.system'], units: { length: values['core.measurementUnits.length'], weight: values['core.measurementUnits.weight'] },
            } });
            else await api.request('/_action/system-config/batch', 'POST', { null: values });
            form.getFields().each(field => field.resetOriginalValue()); notify('Maßsystem gespeichert.');
        } catch (error) { if (api.user && !panel.destroyed) showError(error); }
        finally { saving = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    panel.hasUnsavedChanges = () => saving || (!loading && form.isDirty());
    return panel;
}
export const channelMeasurementPanel = (api, owner) => measurementView(api, owner);
export const measurementModule = { id: 'measurement', title: 'Maßsysteme', group: 'Einstellungen', entity: 'measurement_system',
    access: api => api.can('measurement_system:read') && api.can('measurement_display_unit:read') && api.can('system_config:read'), view: api => measurementView(api) };
