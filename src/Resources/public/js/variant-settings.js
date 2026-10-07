import { entityField, errorHtml } from './entity-fields.js';
import { uuid } from './entity-data.js';
import { encode, notify, showError } from './ui.js';

export function variantSettingsPanel(api, product) {
    let original; let options = []; let restrictions = []; let saving = false; let loading = false; let baseline = '';
    const writable = api.can('product:update');
    const groups = Ext.create('Ext.data.Store', { fields: ['id', 'name', 'representation', 'expressionForListings', 'raw'] });
    const exclusions = Ext.create('Ext.data.Store', { fields: ['id', 'label'] });
    const mode = Ext.widget(entityField(api, { name: 'mode', label: 'Darstellung in Produktlisten', type: 'select', options: [
        ['auto', 'Automatisch eine Variante'], ['parent', 'Hauptprodukt'], ['variant', 'Bestimmte Variante'], ['expanded', 'Varianten nach Gruppen auffächern'],
    ] }, 'auto', writable));
    mode.disable();
    const mainVariant = entityField(api, { name: 'mainVariant', label: 'Hauptvariante', type: 'reference', reference: { entity: 'product', labelFields: ['productNumber', 'name'], filter: [{ type: 'equals', field: 'parentId', value: product.id }] } }, null, writable);
    mode.on('change', (field, value) => mainVariant.setDisabled(value !== 'variant'));
    const grid = Ext.create('Ext.grid.Panel', { title: 'Auswahlgruppen', store: groups, height: 250, plugins: { ptype: 'cellediting', clicksToEdit: 1 },
        columns: [{ text: 'Gruppe', dataIndex: 'name', flex: 1, renderer: encode },
            { text: 'Darstellung', dataIndex: 'representation', width: 130, renderer: value => ({ box: 'Box', select: 'Auswahlliste', color: 'Farbe', image: 'Bild' })[value] || encode(value),
                editor: { xtype: 'combobox', queryMode: 'local', editable: false, store: [['box', 'Box'], ['select', 'Auswahlliste'], ['color', 'Farbe'], ['image', 'Bild']] } },
            { xtype: 'checkcolumn', text: 'Im Listing auffächern', dataIndex: 'expressionForListings', width: 170, disabled: !writable },
        ], tbar: [-1, 1].map(offset => ({ text: offset < 0 ? 'Gruppe nach oben' : 'Gruppe nach unten', disabled: !writable, handler: () => {
            const row = grid.getSelection()[0]; const index = groups.indexOf(row); if (!row || index + offset < 0 || index + offset >= groups.getCount()) return;
            groups.remove(row); groups.insert(index + offset, row); grid.getSelectionModel().select(row);
        } })), listeners: { beforeedit: () => writable },
    });
    const restrictionGrid = Ext.create('Ext.grid.Panel', { title: 'Ausgeschlossene Kombinationen', store: exclusions, height: 240,
        columns: [{ text: 'Diese Kombination wird bei der Generierung ausgelassen', dataIndex: 'label', flex: 1, renderer: encode }],
        tbar: [{ text: 'Ausschluss hinzufügen', disabled: !writable, handler: () => editRestriction() },
            { text: 'Ausschluss bearbeiten', disabled: !writable, handler: () => { const selected = restrictionGrid.getSelection()[0]; if (selected) editRestriction(restrictions.find(item => item.id === selected.id)); } },
            { text: 'Ausschluss entfernen', disabled: !writable, handler: () => { const selected = restrictionGrid.getSelection()[0]; if (selected) { restrictions = restrictions.filter(item => item.id !== selected.id); displayRestrictions(); } } }],
    });
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, items: [grid,
        { xtype: 'component', html: '<p>Bei aufgefächerten Varianten bestimmen die markierten Gruppen die Einträge im Listing. Ausschlüsse gelten für die Variantengenerierung. Bereits vorhandene Varianten bleiben erhalten.</p>' },
        restrictionGrid, { xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
    ] });
    const panel = Ext.create('Ext.panel.Panel', { title: 'Variantendarstellung', layout: 'fit', items: [form],
        dockedItems: [{ xtype: 'form', dock: 'top', bodyPadding: 20, items: [mode, mainVariant] }], bbar: [
        { text: 'Varianteneinstellungen speichern', disabled: !writable, handler: save }, { text: 'Neu laden', handler: () => {
            if (!panel.hasUnsavedChanges()) { load(); return; }
            Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Varianteneinstellungen werden verworfen.', answer => { if (answer === 'yes') load(); });
        } },
    ], listeners: { afterrender: load, destroy: () => { groups.destroy(); exclusions.destroy(); } } });
    panel.hasUnsavedChanges = () => Boolean(original && !loading && baseline !== snapshot());
    function snapshot() { return JSON.stringify([mode.getValue(), mainVariant.getValue(), groups.getRange().map(row => [row.id, row.get('representation'), row.get('expressionForListings')]), restrictions]); }
    async function load() {
        if (saving || loading || panel.destroyed) return; loading = true; mode.disable(); panel.setLoading('Varianteneinstellungen werden geladen …');
        try {
            original = (await api.search('product', { ids: [product.id], limit: 1 })).data[0];
            if (!original) throw new Error('Das Produkt ist nicht mehr vorhanden.');
            options = [];
            for (let page = 1; ; page++) {
                const result = await api.search('product-configurator-setting', { page, limit: 100, filter: [{ type: 'equals', field: 'productId', value: product.id }], associations: { option: { associations: { group: {} } } } });
                options.push(...result.data.map(item => item.option).filter(Boolean)); if (page * 100 >= result.total) break;
            }
            if (panel.destroyed) return;
            const config = original.variantListingConfig || {};
            const groupMap = new Map(options.map(option => [option.groupId, option.group]));
            const known = (config.configuratorGroupConfig || []).map(item => item.id); const groupIds = [...known, ...[...groupMap.keys()].filter(id => !known.includes(id))];
            groups.loadData(groupIds.map(id => {
                const entry = config.configuratorGroupConfig?.find(item => item.id === id) || {};
                return { id, name: groupMap.get(id)?.name || id, representation: entry.representation || 'box', expressionForListings: Boolean(entry.expressionForListings), raw: entry };
            }));
            mode.setValue(config.mainVariantId ? 'variant' : config.displayParent ? 'parent' : groups.getRange().some(row => row.get('expressionForListings')) ? 'expanded' : 'auto');
            mainVariant.setValue(config.mainVariantId || null); mainVariant.setDisabled(mode.getValue() !== 'variant');
            restrictions = structuredClone(original.variantRestrictions || []); displayRestrictions(); baseline = snapshot(); mode.setDisabled(!writable);
        } catch (error) { if (!panel.destroyed) form.down('#error').update(errorHtml(error)); }
        finally { loading = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    function displayRestrictions() {
        exclusions.loadData(restrictions.map(item => ({ id: item.id, label: (item.values || []).map(value => {
            const group = groups.getById(value.group)?.get('name') || value.group;
            return `${group}: ${(value.options || []).map(id => options.find(option => option.id === (typeof id === 'string' ? id : id.optionId))?.name || (typeof id === 'string' ? id : id.optionId)).join(' / ')}`;
        }).join(' UND ') })));
    }
    function editRestriction(originalRestriction) {
        if (!options.length) { showError(new Error('Bitte zuerst Variantenoptionen zuordnen.')); return; }
        const fields = [...new Set(options.map(option => option.groupId))].map(groupId => {
            const existing = originalRestriction?.values?.find(value => value.group === groupId);
            return Ext.widget(entityField(api, { name: groupId, label: groups.getById(groupId)?.get('name') || groupId, type: 'multiselect',
                options: options.filter(option => option.groupId === groupId).map(option => [option.id, option.name]) }, (existing?.options || []).map(option => typeof option === 'string' ? option : option.optionId), true));
        });
        const editor = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, items: [
            { xtype: 'component', html: '<p>Innerhalb einer Gruppe gilt ODER, zwischen den ausgewählten Gruppen UND.</p>' }, ...fields,
            { xtype: 'component', itemId: 'error', cls: 'emz-admin__error' },
        ] });
        const dialog = Ext.create('Ext.window.Window', { title: 'Variantenkombination ausschließen', modal: true, constrain: true, layout: 'fit', width: Math.min(640, innerWidth - 24), height: Math.min(650, innerHeight - 32), items: [editor],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Übernehmen', handler: () => {
                const values = fields.filter(field => field.getValue().length).map(field => ({ ...(originalRestriction?.values?.find(value => value.group === field.getName()) || { id: uuid() }), group: field.getName(), options: field.getValue() }));
                if (!values.length) { editor.down('#error').update('Bitte mindestens eine Ausprägung auswählen.'); return; }
                const updated = { ...(originalRestriction || { id: uuid() }), values };
                if (originalRestriction) restrictions = restrictions.map(item => item.id === originalRestriction.id ? updated : item); else restrictions.push(updated);
                displayRestrictions(); dialog.destroy();
            } }],
        }); dialog.show();
    }
    async function save() {
        if (saving || loading || !writable || !original) return;
        const selectedMode = mode.getValue(); const variantId = selectedMode === 'variant' ? mainVariant.getValue() : null;
        if (selectedMode === 'variant' && !variantId) { form.down('#error').update('Bitte eine Hauptvariante wählen.'); return; }
        if (selectedMode === 'expanded' && !groups.getRange().some(row => row.get('expressionForListings'))) { form.down('#error').update('Bitte mindestens eine Gruppe zum Auffächern markieren.'); return; }
        saving = true; panel.setLoading('Varianteneinstellungen werden gespeichert …');
        try {
            if (variantId) {
                const variant = (await api.search('product', { ids: [variantId], limit: 1 })).data[0];
                if (variant?.parentId !== product.id) throw new Error('Die Hauptvariante gehört nicht zu diesem Produkt.');
            }
            const current = (await api.search('product', { ids: [product.id], limit: 1 })).data[0];
            if (JSON.stringify([current.variantListingConfig, current.variantRestrictions]) !== JSON.stringify([original.variantListingConfig, original.variantRestrictions])) throw new Error('Die Varianteneinstellungen wurden inzwischen geändert. Bitte neu laden.');
            await api.request(`/product/${product.id}`, 'PATCH', { variantListingConfig: {
                displayParent: selectedMode === 'parent', mainVariantId: variantId,
                configuratorGroupConfig: groups.getRange().map(row => ({ ...row.get('raw'), id: row.id, representation: row.get('representation'), expressionForListings: selectedMode === 'auto' ? false : row.get('expressionForListings') })),
            }, variantRestrictions: restrictions });
            baseline = snapshot(); notify('Varianteneinstellungen gespeichert.');
        } catch (error) { if (!panel.destroyed) form.down('#error').update(errorHtml(error)); }
        finally { saving = false; if (!panel.destroyed) { panel.setLoading(false); if (!panel.hasUnsavedChanges()) load(); } }
    }
    return panel;
}
