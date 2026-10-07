import { cmsBlocks, cmsElements } from './cms-catalog.js';
import { loadCmsRecords } from './cms-config.js';
import { cmsPreviewDocument } from './cms-preview.js';
import { editCmsElement } from './cms-element-editor.js';
import { entityListView } from '../entity-list.js';
import { entityField } from '../entity-fields.js';
import { openEntityEditor } from '../entity-editor.js';
import { encode, notify, showError } from '../ui.js';

export function cmsListView(api, config, definition) {
    const grid = entityListView(api, config, definition);
    const button = grid.getDockedItems('toolbar[dock="top"]')[0].add({ text: 'Duplizieren', disabled: true, handler: () => {
        const record = grid.getSelection()[0]?.get('raw'); if (!record) return;
        copyRecord(api, 'cms-page', record, {}, async id => { grid.refreshRecords(); await openEntityEditor(api, config, definition, id, () => grid.refreshRecords()); });
    } });
    grid.on('selectionchange', (selection, rows) => button.setDisabled(rows.length !== 1 || !api.can('cms_page:create')));
    return grid;
}

async function copyRecord(api, entity, record, overwrites, onSaved) {
    Ext.Msg.prompt('Kopie anlegen', 'Name der Kopie', async (choice, name) => {
        if (choice !== 'ok' || !name.trim()) return;
        try {
            const result = await api.request(`/_action/clone/${entity}/${record.id}`, 'POST', { overwrites: { ...overwrites, name: name.trim() } });
            notify('Kopie angelegt.'); onSaved(result.id);
        } catch (error) { if (api.user) showError(error); }
    }, null, false, `${record.name || 'Inhalt'} Kopie`);
}

export function addPositionControls(api, grid, definition, locked) {
    const toolbar = grid.getDockedItems('toolbar[dock="top"]')[0]; let busy = false;
    for (const offset of [-1, 1]) {
        const button = toolbar.add({ text: offset < 0 ? 'Nach oben' : 'Nach unten', disabled: true, handler: async () => {
            const selected = grid.getSelection()[0]?.get('raw'); if (!selected || busy || locked || selected.locked) return;
            busy = true; grid.setLoading('Reihenfolge wird gespeichert …');
            try {
                const records = (await loadCmsRecords(api, definition.entity.replaceAll('_', '-'), definition.filter)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
                const index = records.findIndex(record => record.id === selected.id); const target = index + offset;
                if (index >= 0 && target >= 0 && target < records.length && !records[target].locked) {
                    [records[index], records[target]] = [records[target], records[index]];
                    await persistOrder(api, definition.entity, records); grid.refreshRecords();
                }
            } catch (error) { if (api.user) showError(error); }
            finally { busy = false; if (!grid.destroyed) grid.setLoading(false); }
        } });
        grid.on('selectionchange', (selection, rows) => button.setDisabled(locked || rows.length !== 1 || rows[0].get('raw').locked || !api.can(`${definition.entity}:update`)));
    }
}

export function orderPayload(records, extra = {}) {
    return records.map((record, position) => ({ id: record.id, position, ...(extra[record.id] || {}) }));
}
async function persistOrder(api, entity, records, extra) {
    await api.request('/_action/sync', 'POST', { 'cms-order': { action: 'upsert', entity, payload: orderPayload(records, extra) } });
}

export function cmsStructure(api, config, page, sectionDefinition, blockDefinition) {
    let sections = []; let blocks = []; let slots = []; let busy = false; let sequence = 0; let previewSequence = 0;
    const store = Ext.create('Ext.data.TreeStore', { fields: ['id', 'kind', 'raw', 'text'], root: { expanded: true, children: [] } });
    const tree = Ext.create('Ext.tree.Panel', { title: 'Seitenstruktur', region: 'west', split: true, width: 300, minWidth: 220, rootVisible: false, store,
        displayField: 'text', columns: [{ xtype: 'treecolumn', dataIndex: 'text', flex: 1, renderer: encode }],
        viewConfig: { plugins: { ptype: 'treeviewdragdrop', appendOnly: false }, listeners: { beforedrop: (node, data, target, position, handlers) => {
            handlers.wait = true; handlers.cancelDrop(); drop(data.records[0], target, position); return false;
        } } }, listeners: { itemdblclick: () => edit(), selectionchange: () => updateButtons() },
    });
    const viewport = Ext.create('Ext.form.field.ComboBox', { ariaLabel: 'Vorschaugröße', width: 120, editable: false, queryMode: 'local', store: [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Mobil']], value: 'desktop', listeners: { change: () => preview() } });
    const contextField = ['product_detail', 'product_list'].includes(page.type) ? entityField(api, { name: 'previewContext', label: page.type === 'product_detail' ? 'Vorschauprodukt' : 'Vorschaukategorie', type: 'reference', reference: { entity: page.type === 'product_detail' ? 'product' : 'category' } }, null, true) : null;
    const frame = Ext.create('Ext.Component', { autoEl: { tag: 'iframe', title: 'Layout-Vorschau', sandbox: '', referrerpolicy: 'no-referrer' }, cls: 'emz-admin__cms-preview' });
    const previewPanel = Ext.create('Ext.panel.Panel', { region: 'center', layout: 'fit', cls: 'emz-admin__cms-desktop', items: [frame],
        tbar: [viewport, ...(contextField ? [contextField] : []), { text: 'Vorschau laden', handler: preview }],
        bbar: [{ xtype: 'tbtext', text: 'Aufbau und Inhalte als Vorschau. Im Shop gilt das gewählte Theme.' }],
    });
    const panel = Ext.create('Ext.panel.Panel', { title: 'Gestaltung', layout: 'border', items: [tree, previewPanel], tbar: { enableOverflow: true, items: [
        { text: 'Abschnitt hinzufügen', itemId: 'addSection', disabled: page.locked || !api.can('cms_section:create'), handler: () => openEntityEditor(api, config, sectionDefinition(page), null, reload) },
        { text: 'Block hinzufügen', itemId: 'addBlock', disabled: true, handler: () => { const section = currentSection(); if (section) openEntityEditor(api, config, blockDefinition(section, page), null, reload); } },
        { text: 'Bearbeiten', itemId: 'edit', disabled: true, handler: edit },
        { text: 'Duplizieren', itemId: 'copy', disabled: true, handler: duplicate },
        { text: 'Löschen', itemId: 'remove', disabled: true, handler: remove },
        { text: 'Nach oben', itemId: 'up', disabled: true, handler: () => move(-1) }, { text: 'Nach unten', itemId: 'down', disabled: true, handler: () => move(1) },
        { text: 'Aktualisieren', handler: reload },
    ] }, listeners: { afterrender: reload, activate: () => { if (panel.rendered) reload(); }, destroy: () => store.destroy() } });
    function selected() { return tree.getSelection()[0]; }
    function currentSection() {
        const node = selected(); if (!node) return null;
        if (node.get('kind') === 'section') return node.get('raw');
        const block = node.get('kind') === 'block' ? node.get('raw') : blocks.find(block => block.id === node.get('raw').blockId);
        return sections.find(section => section.id === block?.sectionId);
    }
    function isLocked(node) { return page.locked || node?.get('raw')?.locked || currentSection()?.locked; }
    function entity(node) { return `cms_${node.get('kind')}`; }
    function updateButtons() {
        if (panel.destroyed) return;
        const node = selected(); const kind = node?.get('kind'); const record = node?.get('raw'); const section = currentSection();
        panel.down('#addBlock').setDisabled(!section || page.locked || section.locked || !api.can('cms_block:create'));
        panel.down('#edit').setDisabled(!node);
        panel.down('#copy').setDisabled(!node || kind === 'slot' || page.locked || section?.locked || !api.can(`${entity(node)}:create`));
        panel.down('#remove').setDisabled(!node || kind === 'slot' || isLocked(node) || !api.can(`${entity(node)}:delete`));
        for (const name of ['up', 'down']) panel.down(`#${name}`).setDisabled(!record || kind === 'slot' || isLocked(node) || !api.can(`${entity(node)}:update`));
    }
    async function reload() {
        if (panel.destroyed || busy || !api.user) return;
        const request = ++sequence; panel.setLoading('Erlebniswelt wird geladen …');
        try {
            const results = await Promise.all([
                loadCmsRecords(api, 'cms-section', [{ type: 'equals', field: 'pageId', value: page.id }]),
                loadCmsRecords(api, 'cms-block', [{ type: 'equals', field: 'section.pageId', value: page.id }]),
                loadCmsRecords(api, 'cms-slot', [{ type: 'equals', field: 'block.section.pageId', value: page.id }]),
            ]);
            if (panel.destroyed || request !== sequence) return;
            [sections, blocks, slots] = results;
            const order = list => list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
            const current = selected()?.id;
            store.setRoot({ expanded: true, children: order(sections).map(section => ({ id: section.id, kind: 'section', raw: section, text: section.name || 'Abschnitt', expanded: true,
                children: order(blocks.filter(block => block.sectionId === section.id)).map(block => ({ id: block.id, kind: 'block', raw: block,
                    text: `${block.sectionPosition === 'sidebar' ? 'Seitenleiste: ' : ''}${block.name || cmsBlocks.find(item => item.name === block.type)?.label || block.type}`, expanded: true,
                    children: slots.filter(slot => slot.blockId === block.id).map(slot => ({ id: slot.id, kind: 'slot', raw: slot, leaf: true,
                        text: `${slot.slot}: ${cmsElements.find(item => item.name === slot.type)?.label || slot.type}` })),
                })),
            })) });
            if (current && store.getNodeById(current)) tree.getSelectionModel().select(store.getNodeById(current)); updateButtons(); await preview();
        } catch (error) { if (api.user && !panel.destroyed) showError(error); }
        finally { if (!panel.destroyed && request === sequence) panel.setLoading(false); }
    }
    async function preview() {
        if (!frame.rendered || frame.destroyed) return;
        const request = ++previewSequence;
        try {
            const context = {};
            if (contextField?.getValue()) {
                const entity = page.type === 'product_detail' ? 'product' : 'category';
                const response = await api.search(entity, { ids: [contextField.getValue()], limit: 1, associations: entity === 'product' ? {
                    cover: { associations: { media: {} } }, media: { limit: 100, associations: { media: {} } }, manufacturer: { associations: { media: {} } },
                } : { media: {} } }, { headers: { 'sw-inheritance': '1' } }); context[entity] = response.data[0];
            }
            const html = await cmsPreviewDocument(api, page, sections, blocks, slots, context, viewport.getValue());
            if (frame.destroyed || request !== previewSequence) return;
            previewPanel.removeCls(['emz-admin__cms-desktop', 'emz-admin__cms-tablet', 'emz-admin__cms-mobile']); previewPanel.addCls(`emz-admin__cms-${viewport.getValue()}`);
            frame.getEl().dom.srcdoc = html;
        } catch (error) { if (api.user && !panel.destroyed) showError(error); }
    }
    function edit() {
        const node = selected(); if (!node) return;
        const kind = node.get('kind'); const record = node.get('raw');
        if (kind === 'slot') { editCmsElement(api, config, record.id, isLocked(node), reload); return; }
        openEntityEditor(api, config, kind === 'section' ? sectionDefinition(page) : blockDefinition(currentSection(), page), record.id, reload);
    }
    function duplicate() {
        const node = selected(); if (!node || node.get('kind') === 'slot' || page.locked || currentSection()?.locked) return;
        const record = node.get('raw'); const siblings = node.parentNode.childNodes.map(child => child.get('raw'));
        copyRecord(api, entity(node).replace('_', '-'), record, { position: Math.max(...siblings.map(item => item.position)) + 1 }, reload);
    }
    function remove() {
        const node = selected(); if (!node || node.get('kind') === 'slot' || isLocked(node) || busy) return;
        Ext.Msg.confirm('Inhalt löschen?', `„${encode(node.get('text'))}“ und die enthaltenen Inhalte werden gelöscht.`, async choice => {
            if (choice !== 'yes' || busy || panel.destroyed) return;
            await mutate(() => api.request(`/${entity(node).replace('_', '-')}/${node.id}`, 'DELETE'));
        });
    }
    async function mutate(action) {
        if (busy || panel.destroyed) return; busy = true; panel.setLoading('Änderung wird gespeichert …');
        try { await action(); }
        catch (error) { if (api.user) showError(error); }
        finally { busy = false; if (!panel.destroyed) { panel.setLoading(false); reload(); } }
    }
    async function move(offset) {
        const node = selected(); if (!node || node.get('kind') === 'slot' || isLocked(node) || busy) return;
        const siblings = node.parentNode.childNodes.map(child => child.get('raw')); const index = siblings.findIndex(item => item.id === node.id); const target = index + offset;
        if (target < 0 || target >= siblings.length || siblings[target].locked) return;
        [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
        await mutate(() => persistOrder(api, entity(node), siblings));
    }
    async function drop(node, target, position) {
        if (!node || node === target || busy || page.locked || node.get('raw')?.locked || target?.get('raw')?.locked || node.get('kind') === 'slot') return;
        const kind = node.get('kind');
        if (!api.can(`${entity(node)}:update`)) return;
        const parent = position === 'append' ? target : target.parentNode;
        if ((kind === 'section' && !parent.isRoot()) || (kind === 'block' && parent.get('kind') !== 'section') || parent.get('raw')?.locked || node.parentNode.get('raw')?.locked) return;
        const siblings = parent.childNodes.filter(child => child !== node).map(child => child.get('raw'));
        const index = position === 'append' ? siblings.length : siblings.findIndex(item => item.id === target.id) + (position === 'after' ? 1 : 0);
        siblings.splice(index, 0, node.get('raw'));
        const extra = kind === 'block' ? { [node.id]: { sectionId: parent.id, ...(parent.get('raw').type !== 'sidebar' ? { sectionPosition: 'main' } : {}) } } : {};
        await mutate(() => persistOrder(api, entity(node), siblings, extra));
    }
    return panel;
}
