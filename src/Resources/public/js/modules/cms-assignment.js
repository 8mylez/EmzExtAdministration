import { cmsElements, cmsBlocks } from './cms-catalog.js';
import { loadCmsRecords } from './cms-config.js';
import { editCmsElement } from './cms-element-editor.js';
import { cmsPreviewDocument } from './cms-preview.js';
import { entityField } from '../entity-fields.js';
import { entityPath } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';

const configs = (record, field) => record.translated?.[field] || record[field] || {};

export function cmsAssignmentPanel(api, config, owner) {
    const field = owner.field || 'slotConfig'; const pageField = owner.pageField || 'cmsPageId';
    let record; let page; let slots = []; let busy = false; let requestId = 0;
    const writable = api.can(`${owner.entity}:update`);
    const language = entityField(api, { name: 'contentLanguage', label: 'Sprache', required: true, type: 'reference', reference: { entity: 'language' } }, config.languageId, true);
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'block', 'position', 'element', 'overridden'] });
    const grid = Ext.create('Ext.grid.Panel', { store, columns: [
        { text: 'Block', dataIndex: 'block', flex: 1, renderer: encode }, { text: 'Position', dataIndex: 'position', width: 120, renderer: encode },
        { text: 'Element', dataIndex: 'element', flex: 1, renderer: encode }, { text: 'Inhalt', dataIndex: 'overridden', width: 150, renderer: value => value ? 'Individuell' : 'Layout-Vorgabe' },
    ], listeners: { itemdblclick: () => edit(), selectionchange: () => updateButtons() } });
    const panel = Ext.create('Ext.panel.Panel', { title: 'Layout-Inhalte', layout: 'fit', items: [grid],
        tbar: { enableOverflow: true, items: [language, { text: 'Inhalte laden', handler: reload }, { text: 'Inhalt bearbeiten', itemId: 'editContent', disabled: true, handler: edit },
            { text: 'Layout-Vorgabe verwenden', itemId: 'resetContent', disabled: true, handler: reset }, { text: 'Vorschau', itemId: 'previewContent', disabled: true, handler: preview }] },
        bbar: [{ xtype: 'tbtext', itemId: 'layoutInfo', text: 'Layout-Zuordnung zuerst in den Stammdaten speichern.' }],
        listeners: { afterrender: reload, destroy: () => store.destroy() },
    });
    async function read(inherited = true, selectedLanguage = language.getValue(), preview = false) {
        const associations = preview && owner.entity === 'product' ? {
            ...(api.can('product_media:read') && api.can('media:read') ? { cover: { associations: { media: {} } }, media: { limit: 6, associations: { media: {} } } } : {}),
            ...(api.can('product_manufacturer:read') && api.can('media:read') ? { manufacturer: { associations: { media: {} } } } : {}),
        } : preview && owner.entity === 'category' && api.can('media:read') ? { media: {} } : {};
        const response = await api.search(entityPath(owner.entity), { ids: [owner.id], limit: 1, associations }, { headers: { 'sw-language-id': selectedLanguage, 'sw-inheritance': inherited ? '1' : '0' } });
        if (!response.data[0]) throw new Error('Der Datensatz ist nicht mehr vorhanden.'); return response.data[0];
    }
    function updateButtons() {
        if (panel.destroyed) return;
        const row = grid.getSelection()[0];
        panel.down('#editContent').setDisabled(busy || !row);
        panel.down('#resetContent').setDisabled(busy || !row?.get('overridden') || !writable);
        panel.down('#previewContent').setDisabled(busy || !page);
    }
    async function reload() {
        if (busy || !language.getValue() || panel.destroyed) return;
        const current = ++requestId; panel.setLoading('Layout-Inhalte werden geladen …');
        try {
            const loaded = await read();
            const layout = loaded[pageField] ? (await api.search('cms-page', { ids: [loaded[pageField]], limit: 1 })).data[0] : null;
            const elements = layout ? await loadCmsRecords(api, 'cms-slot', [{ type: 'equals', field: 'block.section.pageId', value: layout.id }], { headers: { 'sw-language-id': language.getValue() } }, { associations: { block: {} } }) : [];
            if (panel.destroyed || current !== requestId) return;
            record = loaded; page = layout; slots = elements;
            const overrides = configs(record, field);
            store.loadData(slots.map(slot => ({ id: slot.id, block: slot.block?.name || cmsBlocks.find(item => item.name === slot.block?.type)?.label || slot.block?.type || 'Block',
                position: slot.slot, element: cmsElements.find(item => item.name === slot.type)?.label || slot.type, overridden: Boolean(overrides[slot.id]) })));
            panel.down('#layoutInfo').setText(page ? `Layout: ${encode(page.name)} · Änderungen gelten für diesen Datensatz und die gewählte Sprache.` : 'Kein Layout zugeordnet. Bitte zuerst ein Layout in den Stammdaten speichern.'); updateButtons();
        } catch (error) { if (!panel.destroyed && api.user) showError(error); }
        finally { if (!panel.destroyed && current === requestId) panel.setLoading(false); }
    }
    async function edit() {
        const id = grid.getSelection()[0]?.id; if (!id || !page || busy) return;
        const pageId = page.id; let baseline;
        await editCmsElement(api, config, id, false, reload, { entity: owner.entity, languageId: language.getValue(),
            load: async selectedLanguage => {
                const current = await read(true, selectedLanguage); assertLayout(current, pageId);
                const value = configs(current, field)[id] || {}; baseline = JSON.stringify(value); return value;
            },
            save: async (value, selectedLanguage) => {
                const current = await read(true, selectedLanguage); assertLayout(current, pageId);
                if (JSON.stringify(configs(current, field)[id] || {}) !== baseline) throw new Error('Dieser Inhalt wurde zwischenzeitlich geändert. Bitte neu laden.');
                // Shopware inherits the entire slotConfig map. Preserve all effective sibling slots when overriding a variant.
                const next = { ...configs(current, field), [id]: value };
                await api.request(`/${entityPath(owner.entity)}/${owner.id}`, 'PATCH', { [field]: next }, { headers: { 'sw-language-id': selectedLanguage } });
            },
        });
    }
    function assertLayout(current, id) { if (current[pageField] !== id) throw new Error('Die Layout-Zuordnung wurde geändert. Bitte die Inhalte neu laden.'); }
    function reset() {
        const id = grid.getSelection()[0]?.id; if (!id || !page || busy || !writable) return;
        Ext.Msg.confirm('Individuellen Inhalt zurücksetzen?', 'Für dieses Element gilt anschließend wieder die Vorgabe des Layouts beziehungsweise des Hauptprodukts.', async answer => {
            if (answer !== 'yes' || busy || panel.destroyed) return;
            busy = true; updateButtons(); panel.setLoading('Inhalt wird zurückgesetzt …');
            try {
                const effective = await read(); assertLayout(effective, page.id);
                const raw = await read(false); const next = { ...configs(effective, field) }; delete next[id];
                const parent = owner.entity === 'product' && raw.parentId ? (await api.search('product', { ids: [raw.parentId], limit: 1 }, { headers: { 'sw-language-id': language.getValue(), 'sw-inheritance': '1' } })).data[0] : null;
                const inherited = parent ? configs(parent, field) : {};
                if (inherited[id]) next[id] = inherited[id];
                const equalToParent = Object.keys({ ...next, ...inherited }).every(key => JSON.stringify(next[key]) === JSON.stringify(inherited[key]));
                await api.request(`/${entityPath(owner.entity)}/${owner.id}`, 'PATCH', { [field]: equalToParent || !Object.keys(next).length ? null : next }, { headers: { 'sw-language-id': language.getValue() } });
                notify('Individueller Inhalt zurückgesetzt.');
            } catch (error) { if (api.user) showError(error); }
            finally { busy = false; if (!panel.destroyed) { panel.setLoading(false); await reload(); } }
        });
    }
    async function preview() {
        if (!page || busy) return;
        busy = true; panel.setLoading('Vorschau wird geladen …'); updateButtons();
        try {
            const current = await read(true, language.getValue(), true); assertLayout(current, page.id);
            const [sections, blocks, translatedSlots] = await Promise.all([
                loadCmsRecords(api, 'cms-section', [{ type: 'equals', field: 'pageId', value: page.id }]),
                loadCmsRecords(api, 'cms-block', [{ type: 'equals', field: 'section.pageId', value: page.id }]),
                loadCmsRecords(api, 'cms-slot', [{ type: 'equals', field: 'block.section.pageId', value: page.id }], { headers: { 'sw-language-id': language.getValue() } }),
            ]);
            const overrides = configs(current, field);
            const html = await cmsPreviewDocument(api, page, sections, blocks, translatedSlots.map(slot => ({ ...slot, config: { ...(slot.translated?.config || slot.config), ...overrides[slot.id] } })), { [owner.entity]: current }, 'desktop');
            const frame = Ext.create('Ext.Component', { autoEl: { tag: 'iframe', title: 'Inhaltsvorschau', sandbox: '', referrerpolicy: 'no-referrer' }, cls: 'emz-admin__cms-preview', listeners: { afterrender: component => { component.el.dom.srcdoc = html; } } });
            Ext.create('Ext.window.Window', { title: 'Inhaltsvorschau', modal: true, constrain: true, layout: 'fit', width: Math.min(1100, innerWidth - 24), height: Math.min(850, innerHeight - 32), items: [frame] }).show();
        } catch (error) { if (api.user) showError(error); }
        finally { busy = false; if (!panel.destroyed) { panel.setLoading(false); updateButtons(); } }
    }
    return panel;
}
