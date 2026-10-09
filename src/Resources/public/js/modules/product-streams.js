import { entityField } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';
import { streamFields, streamFilterChanges, streamQueries } from './stream-data.js';

export function streamTabs(api, config, stream) {
    if (!api.can('product_stream_filter:read')) return [];
    let original = []; let filters = []; let dirty = false; let saving = false; let loaded = false;
    const canWrite = api.can('product_stream:update') && api.can('product:read') && ['create', 'update', 'delete'].every(action => api.can(`product_stream_filter:${action}`));
    const isGroup = filter => ['multi', 'not'].includes(filter?.type);
    const selected = () => filters.find(filter => filter.id === tree.getSelection()[0]?.id);
    const parent = () => isGroup(selected()) ? selected() : filters.find(filter => filter.id === selected()?.parentId) || filters.find(filter => !filter.parentId);
    const store = Ext.create('Ext.data.TreeStore', { root: { expanded: true, children: [] } });
    const tree = Ext.create('Ext.tree.Panel', { title: 'Produktfilter', store, rootVisible: false, useArrows: true,
        columns: [{ xtype: 'treecolumn', text: 'Bedingung', dataIndex: 'text', flex: 1, renderer: encode }],
        tbar: { enableOverflow: true, items: [
            { text: 'Filter hinzufügen', disabled: !canWrite, handler: () => edit() },
            { text: 'Gruppe hinzufügen', disabled: !canWrite, menu: [
                { text: 'UND', handler: () => append({ type: 'multi', operator: 'AND' }) },
                { text: 'ODER', handler: () => append({ type: 'multi', operator: 'OR' }) },
                { text: 'NICHT (UND)', handler: () => append({ type: 'not', operator: 'AND' }) },
                { text: 'NICHT (ODER)', handler: () => append({ type: 'not', operator: 'OR' }) },
            ] },
            { text: 'Bearbeiten', disabled: !canWrite, handler: () => edit(selected()) },
            { text: 'Entfernen', disabled: !canWrite, handler: remove },
            { text: 'Vorschau', disabled: !api.can('product:read'), handler: preview },
            { text: 'Filter speichern', disabled: !canWrite, handler: save },
        ] }, listeners: { afterrender: load, itemdblclick: () => { if (canWrite) edit(selected()); }, destroy: () => store.destroy() },
    });
    tree.hasUnsavedChanges = () => dirty || saving;
    async function load() {
        tree.setLoading('Filter werden geladen …');
        try {
            const records = []; let page = 1;
            while (true) {
                const response = await api.search('product-stream-filter', { page, limit: 100, filter: [{ type: 'equals', field: 'productStreamId', value: stream.id }], sort: [{ field: 'id', order: 'ASC' }] });
                records.push(...response.data); if (records.length >= response.total || !response.data.length) break; page++;
            }
            if (tree.destroyed) return;
            original = records; filters = structuredClone(original);
            if (!filters.length) filters.push({ id: uuid(), type: 'multi', operator: 'AND', parentId: null, position: 0 });
            loaded = true; refresh();
        } catch (error) { if (api.user) showError(error); }
        finally { if (!tree.destroyed) tree.setLoading(false); }
    }
    function refresh(id) {
        const nodes = new Map(filters.map(filter => [filter.id, { id: filter.id, expanded: true, leaf: !isGroup(filter), children: [],
            text: isGroup(filter) ? `${filter.type === 'not' ? 'NICHT ' : ''}${filter.operator === 'OR' ? 'ODER' : 'UND'}`
                : `${streamFields.find(field => field[0] === filter.field)?.[1] || filter.field} · ${filter.type} · ${filter.value ?? (filter.type === 'range' ? JSON.stringify(filter.parameters) : 'leer')}` }]));
        const roots = [];
        for (const filter of [...filters].sort((a, b) => a.position - b.position)) {
            const ancestor = nodes.get(filter.parentId); if (ancestor) { ancestor.children.push(nodes.get(filter.id)); ancestor.leaf = false; }
            else roots.push(nodes.get(filter.id));
        }
        store.setRoot({ expanded: true, children: roots });
        if (id) tree.getSelectionModel().select(store.getNodeById(id));
    }
    function append(values) {
        if (!loaded) return;
        const parentId = parent()?.id || null;
        const filter = { id: uuid(), parentId, position: Math.max(-1, ...filters.filter(item => item.parentId === parentId).map(item => item.position || 0)) + 1, ...values };
        filters.push(filter); dirty = true; refresh(filter.id);
    }
    function remove() {
        const filter = selected(); if (!filter) return;
        if (!filter.parentId) { showError(new Error('Die Hauptgruppe bleibt erhalten. Ihre untergeordneten Filter können entfernt werden.')); return; }
        Ext.Msg.confirm('Filter entfernen?', 'Dieser Filter und seine Untergruppen werden beim Speichern entfernt.', choice => {
            if (choice !== 'yes' || tree.destroyed) return;
            const removed = new Set([filter.id]); let count;
            do { count = removed.size; filters.forEach(item => { if (removed.has(item.parentId)) removed.add(item.id); }); } while (removed.size !== count);
            filters = filters.filter(item => !removed.has(item.id)); dirty = true; refresh(filter.parentId);
        });
    }
    function edit(filter) {
        if (!loaded) return;
        const group = isGroup(filter);
        const field = Ext.create('Ext.form.field.ComboBox', { fieldLabel: 'Produktfeld', name: 'field', labelAlign: 'top', anchor: '100%', queryMode: 'local',
            editable: true, forceSelection: false, displayField: 'label', valueField: 'field',
            store: { fields: ['field', 'label'], data: streamFields.map(([field, label]) => ({ field, label })) },
            listConfig: { getInnerTpl: () => '{label:htmlEncode}' }, value: filter?.field || 'name', allowBlank: false, hidden: group });
        const types = group ? [['multi:AND', 'UND'], ['multi:OR', 'ODER'], ['not:AND', 'NICHT (UND)'], ['not:OR', 'NICHT (ODER)']]
            : [['equals', 'Ist gleich'], ['equalsAny', 'Ist einer von'], ['contains', 'Enthält'], ['prefix', 'Beginnt mit'], ['suffix', 'Endet mit'], ['range', 'Wertebereich']];
        const type = Ext.widget(entityField(api, { name: 'type', label: 'Vergleich', type: 'select', options: types, required: true }, group ? `${filter.type}:${filter.operator}` : filter?.type || 'equals', true));
        const valueForm = Ext.create('Ext.form.Panel', { border: false });
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, items: [field, type, valueForm] });
        let valueField; let nullField;
        const dialog = Ext.create('Ext.window.Window', { title: 'Produktfilter bearbeiten', modal: true, width: 600, maxHeight: window.innerHeight - 40, layout: 'fit', items: [form],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Übernehmen', cls: 'emz-admin__primary', handler: () => {
                if (!form.getForm().isValid()) return;
                let values;
                if (group) { const [kind, operator] = type.getValue().split(':'); values = { type: kind, operator }; }
                else {
                    const fieldName = field.getValue() || field.getRawValue(); const kind = type.getValue();
                    values = { type: kind, field: fieldName, value: null, operator: null, parameters: null };
                    if (kind === 'range') {
                        values.parameters = {};
                        for (const key of ['gt', 'gte', 'lt', 'lte']) { const value = valueForm.getForm().findField(key).getValue(); if (value !== '' && value !== null) values.parameters[key] = value; }
                        if (!Object.keys(values.parameters).length) { showError(new Error('Bitte mindestens eine Grenze angeben.')); return; }
                        if (('gt' in values.parameters && 'gte' in values.parameters) || ('lt' in values.parameters && 'lte' in values.parameters)) { showError(new Error('Bitte je eine untere und obere Grenze verwenden.')); return; }
                    } else if (!nullField?.getValue()) {
                        let value = valueField.getValue();
                        if (Array.isArray(value)) value = value.join('|');
                        values.value = String(value ?? '');
                        if (kind === 'equalsAny' && !values.value) { showError(new Error('Bitte mindestens einen Wert auswählen.')); return; }
                    }
                }
                if (filter) { Object.assign(filter, values); dirty = true; refresh(filter.id); } else append(values);
                dialog.destroy();
            } }] });
        function populate() {
            valueForm.removeAll(true); if (group) return;
            const currentField = field.getValue() || field.getRawValue(); const kind = type.getValue();
            const descriptor = streamFields.find(item => item[0] === currentField)?.[2];
            const initial = filter?.field === currentField && filter?.type === kind ? filter : null;
            if (kind === 'range') {
                for (const [name, label] of [['gte', 'Von (einschließlich)'], ['gt', 'Größer als'], ['lte', 'Bis (einschließlich)'], ['lt', 'Kleiner als']]) valueForm.add(entityField(api,
                    { name, label, type: descriptor === 'datetime' ? 'datetime' : 'number' }, initial?.parameters?.[name], true));
                return;
            }
            const reference = descriptor && !['boolean', 'number', 'datetime'].includes(descriptor) && ['equals', 'equalsAny'].includes(kind);
            let descriptorField = { name: 'value', label: kind === 'equalsAny' ? 'Werte (mit | getrennt)' : 'Wert' };
            let value = initial?.value;
            if (reference) { descriptorField = { ...descriptorField, label: 'Wert', type: 'reference', multiple: kind === 'equalsAny', reference: { entity: descriptor } }; if (kind === 'equalsAny') value = value?.split('|') || []; }
            else if (descriptor === 'boolean' && kind === 'equals') descriptorField = { ...descriptorField, type: 'select', options: [['1', 'Ja'], ['0', 'Nein']] };
            else if (descriptor === 'number' && kind === 'equals') descriptorField.type = 'number';
            const control = entityField(api, descriptorField, value, true);
            valueField = control.isComponent ? control : Ext.widget(control);
            nullField = Ext.create('Ext.form.field.Checkbox', { boxLabel: 'Wert ist leer (NULL)', checked: Boolean(initial && initial.value === null && kind === 'equals'), hidden: kind !== 'equals',
                listeners: { change: (field, value) => valueField.setDisabled(value) } });
            valueForm.add([valueField, nullField]); valueField.setDisabled(nullField.getValue());
        }
        field.on('change', populate); type.on('change', populate); populate(); dialog.show();
    }
    async function save() {
        if (saving || !loaded || !canWrite) return;
        saving = true; tree.setLoading('Produktfilter werden gespeichert …');
        try {
            const queries = streamQueries(filters); if (!queries.length) throw new Error('Bitte mindestens einen Filter anlegen.');
            // Validate the real DAL query before persisting a stream used by storefront listings.
            await api.search('product', { filter: queries, limit: 1, 'total-count-mode': 0 });
            const changes = streamFilterChanges(original, filters); const operations = {};
            if (changes.upsert.length) operations.upsert = { action: 'upsert', entity: 'product_stream_filter', payload: changes.upsert.map(filter => ({ ...filter, productStreamId: stream.id })) };
            if (changes.delete.length) operations.remove = { action: 'delete', entity: 'product_stream_filter', payload: changes.delete };
            if (Object.keys(operations).length) await api.request('/_action/sync', 'POST', operations);
            original = structuredClone(filters); dirty = false; notify('Produktfilter gespeichert.');
        } catch (error) { if (api.user) showError(error); }
        finally { saving = false; if (!tree.destroyed) tree.setLoading(false); }
    }
    function preview() {
        let queries;
        try { queries = streamQueries(filters); } catch (error) { showError(error); return; }
        const store = Ext.create('Ext.data.Store', { fields: ['id', 'name', 'productNumber', 'stock'] }); let page = 1; let request = 0;
        const channel = entityField(api, { name: 'salesChannelId', label: 'Verkaufskanal (leer = gesamter Katalog)', type: 'reference', reference: { entity: 'sales_channel' } }, null, true);
        const grid = Ext.create('Ext.grid.Panel', { store, columns: [{ text: 'Produkt', dataIndex: 'name', flex: 1, renderer: encode },
            { text: 'Produktnummer', dataIndex: 'productNumber', flex: 1, renderer: encode }, { text: 'Bestand', dataIndex: 'stock', width: 100 }],
            tbar: [channel, { text: 'Vorschau laden', handler: () => { page = 1; loadPreview(); } }],
            bbar: [{ text: 'Zurück', itemId: 'previous', disabled: true, handler: () => { page--; loadPreview(); } },
                { xtype: 'tbtext', itemId: 'count' }, { text: 'Weiter', itemId: 'next', disabled: true, handler: () => { page++; loadPreview(); } }],
        });
        const dialog = Ext.create('Ext.window.Window', { title: 'Produktgruppen-Vorschau', modal: true, width: Math.min(960, window.innerWidth - 30), height: 620, layout: 'fit', items: [grid],
            listeners: { afterrender: loadPreview, destroy: () => store.destroy() } }); dialog.show();
        async function loadPreview() {
            const current = ++request; grid.setLoading('Produkte werden geladen …');
            try {
                const criteria = { page, limit: 25, filter: queries, 'total-count-mode': 1 };
                const response = channel.getValue() ? await api.request(`/_admin/product-stream-preview/${channel.getValue()}?displayAsGroup=${Boolean(stream.displayAsGroup)}`, 'POST', criteria,
                    { headers: { 'sw-currency-id': config.currencyId, 'sw-inheritance': 'true' } }) : await api.search('product', criteria, { headers: { 'sw-inheritance': 'true' } });
                if (dialog.destroyed || current !== request) return;
                store.loadData(response.data || Object.values(response.elements || {})); grid.down('#count').setText(`${response.total} Produkte · Seite ${page}`);
                grid.down('#previous').setDisabled(page <= 1); grid.down('#next').setDisabled(page * 25 >= response.total);
            } catch (error) { if (!dialog.destroyed && api.user) showError(error); }
            finally { if (!grid.destroyed && current === request) grid.setLoading(false); }
        }
    }
    return [tree];
}
