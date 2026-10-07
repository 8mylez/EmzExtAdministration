import { entityListView } from '../entity-list.js';
import { openEntityEditor } from '../entity-editor.js';
import { entityField } from '../entity-fields.js';
import { encode, notify, showError } from '../ui.js';

export function orderCategories(records) {
    const remaining = new Map(records.map(record => [record.id, record])); const ordered = []; let previous = null;
    while (remaining.size) {
        const next = [...remaining.values()].find(record => (record.afterCategoryId || null) === previous)
            || [...remaining.values()].find(record => !remaining.has(record.afterCategoryId)) || remaining.values().next().value;
        ordered.push(next); remaining.delete(next.id); previous = next.id;
    }
    return ordered;
}

async function siblings(api, parentId) {
    const records = [];
    for (let page = 1; ; page++) {
        const result = await api.search('category', { page, limit: 100, filter: [{ type: 'equals', field: 'parentId', value: parentId || null }], sort: [{ field: 'id', order: 'ASC' }] });
        records.push(...result.data); if (page * 100 >= result.total) return orderCategories(records);
    }
}
const chain = records => records.map((record, index) => ({ id: record.id, parentId: record.parentId || null, afterCategoryId: records[index - 1]?.id || null }));

export async function validateCategoryParent(api, categoryId, parentId) {
    if (!parentId) return;
    const parent = (await api.search('category', { ids: [parentId], limit: 1 })).data[0];
    if (!parent) throw new Error('Die Zielkategorie ist nicht mehr vorhanden.');
    if (categoryId && (categoryId === parent.id || parent.path?.includes(`|${categoryId}|`))) throw new Error('Eine Kategorie kann weder sich selbst noch einer ihrer Unterkategorien untergeordnet werden.');
}

async function movePayload(api, record, parentId, targetId, after) {
    await validateCategoryParent(api, record.id, parentId);
    const old = await siblings(api, record.parentId); const sameParent = (parentId || null) === (record.parentId || null);
    const target = (sameParent ? old : await siblings(api, parentId)).filter(item => item.id !== record.id);
    const position = targetId ? target.findIndex(item => item.id === targetId) : target.length;
    if (targetId && position < 0) throw new Error('Die Zielkategorie wurde verschoben. Bitte aktualisieren.');
    target.splice(position + (targetId && after ? 1 : 0), 0, { ...record, parentId });
    return [...(sameParent ? [] : chain(old.filter(item => item.id !== record.id))), ...chain(target)];
}

export async function writeCategory(api, path, method, payload) {
    if (method === 'POST') {
        const existing = await siblings(api, payload.parentId);
        return api.request(path, method, { ...payload, afterCategoryId: existing.at(-1)?.id || null });
    }
    const id = path.split('/').at(-1); const record = (await api.search('category', { ids: [id], limit: 1 })).data[0];
    if (!record) throw new Error('Die Kategorie ist nicht mehr vorhanden.');
    if (method === 'DELETE') {
        const next = (await siblings(api, record.parentId)).filter(item => item.id !== id);
        return api.request('/_action/sync', 'POST', { remove: { entity: 'category', action: 'delete', payload: [{ id }] }, ...(next.length ? { reorder: { entity: 'category', action: 'upsert', payload: chain(next) } } : {}) });
    }
    if ('parentId' in payload && payload.parentId !== record.parentId) {
        const changes = await movePayload(api, record, payload.parentId, null, false);
        return api.request('/_action/sync', 'POST', { categories: { entity: 'category', action: 'upsert', payload: changes.map(item => item.id === id ? { ...item, ...payload } : item) } });
    }
    return api.request(path, method, payload);
}

export function categoriesView(api, config, definition) {
    const list = entityListView(api, config, { ...definition, delete: api.can('category:update') }); list.setTitle('Liste');
    let busy = false;
    const store = Ext.create('Ext.data.TreeStore', { fields: ['id', 'text', 'raw', 'loadedChildren', 'placeholder'], root: { id: 'root', expanded: true, children: [] } });
    const tree = Ext.create('Ext.tree.Panel', { title: 'Baum', rootVisible: false, store, displayField: 'text', useArrows: true,
        columns: [{ xtype: 'treecolumn', text: 'Kategorie', dataIndex: 'text', flex: 1, renderer: encode }],
        tbar: { enableOverflow: true, items: [
            { text: 'Neue Hauptkategorie', disabled: !api.can('category:create'), handler: () => create(null) },
            { text: 'Unterkategorie anlegen', itemId: 'child', disabled: true, handler: () => create(selected()?.id) },
            { text: 'Öffnen', itemId: 'open', disabled: true, handler: edit },
            { text: 'Nach oben', itemId: 'up', disabled: true, handler: () => reorder(-1) }, { text: 'Nach unten', itemId: 'down', disabled: true, handler: () => reorder(1) },
            { text: 'Verschieben', itemId: 'move', disabled: true, handler: moveDialog },
            { text: 'Löschen', itemId: 'remove', disabled: true, handler: remove }, '->', { text: 'Aktualisieren', handler: reload },
        ] }, viewConfig: { plugins: { ptype: 'treeviewdragdrop' }, listeners: { beforedrop: (node, data, target, position, handlers) => {
            handlers.cancelDrop(); const record = data.records[0]?.get('raw'); const destination = target?.get('raw');
            if (!record || !destination || record.id === destination.id) return false;
            move(record, position === 'append' ? destination.id : destination.parentId, position === 'append' ? null : destination.id, position === 'after'); return false;
        } } }, listeners: { afterrender: reload, itemdblclick: edit, selectionchange: updateButtons,
            beforeitemexpand: node => { if (node.isRoot() || node.get('loadedChildren')) return true; loadChildren(node); return false; }, destroy: () => store.destroy() },
    });
    const selected = () => tree.getSelection()[0]?.get('raw');
    function updateButtons() {
        const hasSelection = Boolean(selected());
        tree.down('#open').setDisabled(!hasSelection || busy);
        tree.down('#child').setDisabled(!hasSelection || busy || !api.can('category:create'));
        for (const name of ['up', 'down', 'move']) tree.down(`#${name}`).setDisabled(!hasSelection || busy || !api.can('category:update'));
        tree.down('#remove').setDisabled(!hasSelection || busy || !api.can('category:delete') || !api.can('category:update'));
    }
    async function loadChildren(node) {
        if (node.loadingChildren || tree.destroyed) return; node.loadingChildren = true;
        try {
            const records = await siblings(api, node.isRoot() ? null : node.id);
            if (tree.destroyed) return;
            node.removeAll(); node.appendChild(records.map(record => ({ id: record.id, raw: record, text: record.translated?.name || record.name,
                leaf: !record.childCount, loadedChildren: false, ...(record.childCount ? { children: [{ id: `loading-${record.id}`, text: 'Wird geladen …', placeholder: true, leaf: true }] } : {}) })));
            node.set('loadedChildren', true); if (!node.isRoot()) node.set('leaf', !records.length); node.expand();
        } catch (error) { if (!tree.destroyed && api.user) showError(error); }
        finally { node.loadingChildren = false; }
    }
    async function reload() { if (!tree.destroyed) await loadChildren(store.getRoot()); }
    function create(parentId) { openEntityEditor(api, config, { ...definition, defaults: { ...definition.defaults, parentId } }, null, () => { reload(); list.refreshRecords(); }); }
    function edit() { const record = selected(); if (record && !busy) openEntityEditor(api, config, definition, record.id, () => { reload(); list.refreshRecords(); }); }
    async function move(record, parentId, targetId, after) {
        if (busy || !api.can('category:update')) return; busy = true; tree.setLoading('Kategorie wird verschoben …'); updateButtons();
        try {
            const latest = (await api.search('category', { ids: [record.id], limit: 1 })).data[0]; if (!latest) throw new Error('Die Kategorie ist nicht mehr vorhanden.');
            const payload = await movePayload(api, latest, parentId, targetId, after);
            await api.request('/_action/sync', 'POST', { categories: { entity: 'category', action: 'upsert', payload } });
            await reload(); list.refreshRecords(); notify('Kategorie verschoben.');
        } catch (error) { if (!tree.destroyed && api.user) showError(error); }
        finally { busy = false; if (!tree.destroyed) { tree.setLoading(false); updateButtons(); } }
    }
    async function reorder(offset) {
        const record = selected(); if (!record || busy) return;
        try { const records = await siblings(api, record.parentId); const index = records.findIndex(item => item.id === record.id); const target = records[index + offset]; if (target) await move(record, record.parentId, target.id, offset > 0); }
        catch (error) { if (api.user) showError(error); }
    }
    function moveDialog() {
        const record = selected(); if (!record || busy) return;
        const target = entityField(api, { name: 'parent', label: 'Zielkategorie (leer = Hauptebene)', type: 'reference', reference: { entity: 'category' } }, record.parentId, true);
        const dialog = Ext.create('Ext.window.Window', { title: 'Kategorie verschieben', modal: true, constrain: true, width: Math.min(540, innerWidth - 24), bodyPadding: 20, layout: 'anchor', items: [target],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Verschieben', handler: async () => { const id = target.getValue() || null; dialog.destroy(); await move(record, id, null, false); } }],
        }); dialog.show();
    }
    function remove() {
        const record = selected(); if (!record || busy || !api.can('category:delete')) return;
        Ext.Msg.confirm('Kategorie löschen?', `„${encode(record.name)}“ wird einschließlich ihrer Unterkategorien gelöscht.`, async answer => {
            if (answer !== 'yes' || busy || tree.destroyed) return; busy = true; tree.setLoading('Kategorie wird gelöscht …'); updateButtons();
            try { await writeCategory(api, `/category/${record.id}`, 'DELETE'); await reload(); list.refreshRecords(); }
            catch (error) { if (api.user) showError(error); }
            finally { busy = false; if (!tree.destroyed) { tree.setLoading(false); updateButtons(); } }
        });
    }
    return Ext.create('Ext.tab.Panel', { items: [list, tree] });
}
