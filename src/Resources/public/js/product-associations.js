import { entityField } from './entity-fields.js';
import { entityPath } from './entity-data.js';
import { encode, notify, showError } from './ui.js';

export const productAssociations = [
    { title: 'Kategorien', entity: 'category', association: 'categories', reverse: 'products', mapping: 'product_category', foreignKey: 'categoryId' },
    { title: 'Tags', entity: 'tag', association: 'tags', reverse: 'products', mapping: 'product_tag', foreignKey: 'tagId' },
    { title: 'Eigenschaften', entity: 'property_group_option', association: 'properties', reverse: 'productProperties', mapping: 'product_property', foreignKey: 'optionId' },
    { title: 'Zusatzfeld-Sets', entity: 'custom_field_set', association: 'customFieldSets', reverse: 'products', mapping: 'product_custom_field_set', foreignKey: 'customFieldSetId' },
];

export async function associationRecords(api, relation, productId) {
    const records = [];
    for (let page = 1; ; page++) {
        const result = await api.search(entityPath(relation.entity), { page, limit: 100, filter: [{ type: 'equals', field: `${relation.reverse}.id`, value: productId }], sort: [{ field: 'id', order: 'ASC' }] });
        records.push(...result.data); if (page * 100 >= result.total) return records;
    }
}

export function inheritedProductChildren(api, product, grid, definition) {
    if (!product.parentId) return grid;
    const entity = entityPath(definition.entity); const filter = definition.filter.find(item => item.field === 'productId');
    let inherited = true; let forcedOwn = false; let busy = false;
    const canCopy = ['product:update', `${definition.entity}:create`].every(privilege => api.can(privilege));
    const canReset = ['product:update', `${definition.entity}:delete`].every(privilege => api.can(privilege));
    const panel = Ext.create('Ext.panel.Panel', { title: definition.title, layout: 'fit', items: [grid], tbar: { enableOverflow: true, items: [
        { xtype: 'tbtext', itemId: 'state', text: 'Vererbung wird geprüft …' },
        { text: 'Eigene Einträge verwenden', itemId: 'copy', disabled: true, handler: copy },
        { text: 'Vom Hauptprodukt erben', itemId: 'reset', disabled: true, handler: reset }, '->', { text: 'Aktualisieren', handler: reload },
    ] }, listeners: { afterrender: reload } });
    grid.disable();
    async function rows(productId) {
        const all = [];
        for (let page = 1; ; page++) {
            const result = await api.search(entity, { page, limit: 100, filter: [{ type: 'equals', field: 'productId', value: productId }], sort: [{ field: 'id', order: 'ASC' }] });
            all.push(...result.data); if (page * 100 >= result.total) return all;
        }
    }
    async function reload() {
        if (busy || panel.destroyed) return;
        panel.setLoading('Vererbung wird geladen …');
        try {
            const own = await api.search(entity, { limit: 1, filter: [{ type: 'equals', field: 'productId', value: product.id }] });
            if (panel.destroyed) return;
            inherited = !forcedOwn && own.total === 0; filter.value = inherited ? product.parentId : product.id;
            grid.setDisabled(inherited); await grid.refreshRecords();
            panel.down('#state').setText(inherited ? 'Vom Hauptprodukt geerbt' : 'Eigene Einträge');
            panel.down('#copy').setDisabled(!canCopy || !inherited); panel.down('#reset').setDisabled(!canReset || inherited);
        } catch (error) { if (!panel.destroyed && api.user) showError(error); }
        finally { if (!panel.destroyed) panel.setLoading(false); }
    }
    async function copy() {
        if (busy || !inherited || !canCopy) return;
        busy = true; panel.setLoading('Einträge werden übernommen …');
        try {
            if ((await rows(product.id)).length) throw new Error('Es sind inzwischen eigene Einträge vorhanden. Bitte aktualisieren.');
            const parent = (await api.search('product', { ids: [product.parentId], limit: 1 })).data[0];
            for (const source of await rows(product.parentId)) {
                const result = await api.request(`/_action/clone/${entity}/${source.id}`, 'POST', { overwrites: { productId: product.id } });
                if (definition.entity === 'product_media' && source.id === parent?.coverId) await api.request(`/product/${product.id}`, 'PATCH', { coverId: result.id });
            }
            forcedOwn = true; notify('Einträge als eigene Werte übernommen.');
        } catch (error) { if (api.user) showError(new Error(`${error.message} Bereits übernommene Einträge werden nach dem Aktualisieren angezeigt.`)); }
        finally { busy = false; if (!panel.destroyed) { panel.setLoading(false); await reload(); } }
    }
    function reset() {
        if (busy || !canReset || inherited) return;
        Ext.Msg.confirm('Einträge vererben?', 'Die eigenen Einträge dieses Reiters werden entfernt. Anschließend gelten wieder die Werte des Hauptprodukts.', async answer => {
            if (answer !== 'yes' || busy || panel.destroyed) return; busy = true; panel.setLoading('Vererbung wird wiederhergestellt …');
            try {
                const own = await rows(product.id); const operations = {};
                if (definition.entity === 'product_media') operations.cover = { entity: 'product', action: 'upsert', payload: [{ id: product.id, coverId: null }] };
                if (own.length) operations.entries = { entity: definition.entity, action: 'delete', payload: own.map(record => ({ id: record.id })) };
                if (Object.keys(operations).length) await api.request('/_action/sync', 'POST', operations);
                forcedOwn = false; notify('Vererbung wiederhergestellt.');
            } catch (error) { if (api.user) showError(error); }
            finally { busy = false; if (!panel.destroyed) { panel.setLoading(false); await reload(); } }
        });
    }
    panel.isSaving = () => busy;
    return panel;
}

export function productAssociationPanel(api, product, relation) {
    const { title, entity, association, mapping, reverse, foreignKey } = relation;
    const writable = api.can('product:update'); const canAdd = writable && api.can(`${mapping}:create`); const canRemove = writable && api.can(`${mapping}:delete`);
    let inherited = false; let busy = false; let page = 1; let term = ''; let generation = 0;
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'name'] });
    const task = new Ext.util.DelayedTask(() => { page = 1; refresh(); });
    const grid = Ext.create('Ext.grid.Panel', { title, store, emptyText: 'Keine Zuordnungen vorhanden.', viewConfig: { deferEmptyText: false },
        columns: [{ text: title, dataIndex: 'name', flex: 1, renderer: encode }],
        tbar: { enableOverflow: true, items: [
            { text: 'Zuordnen', disabled: !canAdd, handler: assign }, { text: 'Zuordnung entfernen', itemId: 'removeAssociation', disabled: true, handler: remove },
            ...(product.parentId ? [{ text: 'Zuordnungen übernehmen', itemId: 'copyAssociation', disabled: true, handler: copy },
                { text: 'Vom Hauptprodukt erben', itemId: 'inheritAssociation', disabled: true, handler: reset }] : []),
            '->', { text: 'Aktualisieren', handler: refresh },
        ] }, dockedItems: [{ xtype: 'toolbar', dock: 'top', items: [
            { xtype: 'textfield', ariaLabel: `${title} suchen`, emptyText: 'Suchen …', listeners: { change: (field, value) => { term = value; task.delay(300); } } },
            { xtype: 'tbtext', itemId: 'inheritanceState', text: '' },
        ] }], bbar: [{ text: 'Zurück', itemId: 'previous', disabled: true, handler: () => { page--; refresh(); } },
            { xtype: 'tbtext', itemId: 'pagination', text: 'Einträge werden geladen …' }, { text: 'Weiter', itemId: 'next', disabled: true, handler: () => { page++; refresh(); } }],
        listeners: { afterrender: refresh, selectionchange: updateButtons, destroy: () => { task.cancel(); store.destroy(); } },
    });
    function updateButtons() {
        grid.down('#removeAssociation').setDisabled(busy || !canRemove || inherited || !grid.getSelection().length);
        grid.down('#copyAssociation')?.setDisabled(busy || !canAdd || !inherited);
        grid.down('#inheritAssociation')?.setDisabled(busy || !canRemove || inherited);
    }
    async function ownExists() {
        return (await api.search(entityPath(entity), { limit: 1, filter: [{ type: 'equals', field: `${reverse}.id`, value: product.id }] })).total > 0;
    }
    async function refresh() {
        if (grid.destroyed || !api.user) return;
        const current = ++generation; grid.setLoading('Zuordnungen werden geladen …');
        try {
            const inherits = Boolean(product.parentId) && !(await ownExists());
            const result = await api.search(entityPath(entity), { page, limit: 25, sort: [{ field: 'name', order: 'ASC' }], filter: [
                { type: 'equals', field: `${reverse}.id`, value: inherits ? product.parentId : product.id }, ...(term.trim() ? [{ type: 'contains', field: 'name', value: term.trim() }] : []),
            ] });
            if (grid.destroyed || current !== generation) return;
            inherited = inherits; store.loadData(result.data.map(record => ({ id: record.id, name: record.translated?.name || record.name })));
            grid.down('#inheritanceState').setText(inherited ? 'Vom Hauptprodukt geerbt' : product.parentId ? 'Eigene Zuordnungen' : '');
            grid.down('#pagination').setText(`Seite ${page} von ${Math.max(1, Math.ceil(result.total / 25))} · ${result.total} Einträge`);
            grid.down('#previous').setDisabled(page <= 1); grid.down('#next').setDisabled(page * 25 >= result.total); updateButtons();
        } catch (error) { if (!grid.destroyed && api.user) showError(error); }
        finally { if (!grid.destroyed && current === generation) grid.setLoading(false); }
    }
    async function run(operation) {
        if (busy || grid.destroyed) return; busy = true; grid.setLoading('Zuordnungen werden gespeichert …'); updateButtons();
        try { await operation(); page = 1; await refresh(); }
        catch (error) { if (!grid.destroyed && api.user) showError(error); }
        finally { busy = false; if (!grid.destroyed) { grid.setLoading(false); updateButtons(); } }
    }
    async function copy() {
        if (!canAdd || !product.parentId) return;
        await run(async () => {
            if (await ownExists()) throw new Error('Es gibt inzwischen eigene Zuordnungen. Bitte aktualisieren.');
            const records = await associationRecords(api, relation, product.parentId);
            if (!records.length) { notify('Das Hauptprodukt besitzt keine Zuordnungen. Eigene Einträge können direkt zugeordnet werden.'); return; }
            await api.request(`/product/${product.id}`, 'PATCH', { [association]: records.map(record => ({ id: record.id })) }); notify('Zuordnungen als eigene Werte übernommen.');
        });
    }
    function reset() {
        if (!canRemove || !product.parentId || inherited) return;
        Ext.Msg.confirm('Zuordnungen vererben?', 'Alle eigenen Zuordnungen dieses Reiters werden entfernt. Danach gelten die Zuordnungen des Hauptprodukts.', answer => {
            if (answer !== 'yes') return;
            run(async () => {
                const records = await associationRecords(api, relation, product.id);
                if (records.length) await api.request('/_action/sync', 'POST', { 'inherit-product-association': { entity: mapping, action: 'delete', payload: records.map(record => ({ productId: product.id, [foreignKey]: record.id })) } });
                notify('Vererbung wiederhergestellt.');
            });
        });
    }
    function remove() {
        const record = grid.getSelection()[0]; if (!record || inherited || !canRemove || busy) return;
        Ext.Msg.confirm('Zuordnung entfernen?', `„${encode(record.get('name'))}“ wird entfernt.${product.parentId ? ' Ohne eigene Zuordnungen erbt die Variante wieder vom Hauptprodukt.' : ''}`, answer => {
            if (answer !== 'yes') return;
            const path = association.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
            run(() => api.request(`/product/${product.id}/${path}/${record.id}`, 'DELETE'));
        });
    }
    function assign() {
        if (!canAdd || busy) return;
        const field = entityField(api, { name: 'ids', label: title, multiple: true, required: true, type: 'reference', reference: { entity } }, [], true); let saving = false;
        const dialog = Ext.create('Ext.window.Window', { title: `${title} zuordnen`, modal: true, constrain: true, width: Math.min(620, innerWidth - 24), bodyPadding: 20, layout: 'anchor', items: [field],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Zuordnen', cls: 'emz-admin__primary', handler: async () => {
                if (saving || !field.isValid()) return; saving = true; dialog.setLoading('Zuordnungen werden gespeichert …');
                try {
                    const parentValues = product.parentId && !(await ownExists()) ? await associationRecords(api, relation, product.parentId) : [];
                    const ids = [...new Set([...parentValues.map(record => record.id), ...field.getValue()])];
                    await api.request(`/product/${product.id}`, 'PATCH', { [association]: ids.map(id => ({ id })) }); dialog.destroy(); await refresh();
                } catch (error) { if (api.user) showError(error); }
                finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
            } }], listeners: { beforeclose: () => !saving },
        }); dialog.show();
    }
    grid.isSaving = () => busy;
    return grid;
}
