import { entityField } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';

const productFields = [['name', 'Name'], ['description', 'Beschreibung'], ['productNumber', 'Produktnummer'], ['manufacturerNumber', 'Herstellernummer'], ['ean', 'EAN'], ['width', 'Breite'], ['height', 'Höhe'], ['length', 'Länge'], ['weight', 'Gewicht'], ['packUnit', 'Verpackungseinheit']];
const types = [['product', 'Produktinformation'], ['property', 'Eigenschaft'], ['customField', 'Zusatzfeld'], ['referencePrice', 'Grundpreis']];

function featurePanel(api, record) {
    const writable = api.can('product_feature_set:update');
    let saving = false;
    let dirty = false;
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'name', 'type', 'position'], data: [...(record.features || [])].sort((a, b) => a.position - b.position) });
    const panel = Ext.create('Ext.grid.Panel', { title: 'Merkmale', store,
        columns: [{ text: 'Typ', dataIndex: 'type', width: 190, renderer: value => encode(types.find(([key]) => key === value)?.[1] || value) },
            { text: 'Merkmal', dataIndex: 'name', flex: 1, renderer: value => encode(productFields.find(([key]) => key === value)?.[1] || value) }],
        tbar: [{ text: 'Merkmal hinzufügen', disabled: !writable, handler: add },
            { text: 'Entfernen', disabled: !writable, handler: () => { const selected = panel.getSelection()[0]; if (selected) { store.remove(selected); dirty = true; } } },
            { text: 'Nach oben', disabled: !writable, handler: () => move(-1) }, { text: 'Nach unten', disabled: !writable, handler: () => move(1) }],
        bbar: ['->', { text: 'Merkmale speichern', disabled: !writable, handler: async () => {
            if (!dirty || saving) return;
            saving = true; panel.setLoading('Merkmale werden gespeichert …');
            try { await api.request(`/product-feature-set/${record.id}`, 'PATCH', { features: store.getRange().map((row, index) => ({ ...row.data, position: index + 1 })) }); dirty = false; notify('Merkmale gespeichert.'); }
            catch (error) { if (api.user && !panel.destroyed) showError(error); }
            finally { saving = false; if (!panel.destroyed) panel.setLoading(false); }
        } }],
        listeners: { destroy: () => store.destroy() },
    });
    panel.hasUnsavedChanges = () => dirty;
    function move(direction) {
        const row = panel.getSelection()[0]; if (!row) return;
        const index = store.indexOf(row); const next = index + direction;
        if (next < 0 || next >= store.getCount()) return;
        store.remove(row); store.insert(next, row); panel.setSelection(row); dirty = true;
    }
    function add() {
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, items: [
            entityField(api, { name: 'type', label: 'Typ', type: 'select', required: true, options: types }, 'product', true),
            { xtype: 'container', itemId: 'value', layout: 'anchor' },
        ] });
        const type = form.getForm().findField('type');
        const dialog = Ext.create('Ext.window.Window', { title: 'Merkmal hinzufügen', width: Math.min(520, innerWidth - 24), modal: true, constrain: true, layout: 'fit', items: [form], buttons: [
            { text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Hinzufügen', handler: () => {
                if (!form.getForm().isValid()) return;
                const kind = type.getValue(); const field = form.getForm().findField('value'); const value = field?.getValue();
                const row = kind === 'referencePrice' ? { id: uuid(), name: 'referencePrice', type: kind }
                    : kind === 'product' ? { id: uuid(), name: value, type: kind }
                        : { id: value, name: field.getRawValue(), type: kind };
                if (store.getRange().some(existing => existing.get('type') === kind && (kind === 'property' || kind === 'customField' ? existing.id === row.id : existing.get('name') === row.name))) { showError(new Error('Dieses Merkmal ist bereits enthalten.')); return; }
                store.add({ ...row, position: store.getCount() + 1 }); dirty = true; dialog.close();
            } },
        ] });
        function update() {
            const holder = form.down('#value'); holder.removeAll(true); const kind = type.getValue();
            if (kind === 'referencePrice') return;
            holder.add(entityField(api, kind === 'product' ? { name: 'value', label: 'Produktinformation', type: 'select', options: productFields, required: true }
                : { name: 'value', label: kind === 'property' ? 'Eigenschaft' : 'Zusatzfeld', type: 'reference', required: true, reference: { entity: kind === 'property' ? 'property_group' : 'custom_field' } }, null, true));
        }
        type.on('change', update); update(); dialog.show();
    }
    return panel;
}

export const featureSetsModule = { id: 'feature-sets', title: 'Wesentliche Merkmale', singular: 'Merkmal-Set', entity: 'product_feature_set', group: 'Einstellungen',
    search: ['name', 'description'], sort: 'name', direction: 'ASC', columns: [{ field: 'name', label: 'Name' }, { field: 'description', label: 'Beschreibung' }],
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Beschreibung', type: 'textarea' }], defaults: { features: [] },
    detailTabs: (api, config, record) => [featurePanel(api, record)],
};
