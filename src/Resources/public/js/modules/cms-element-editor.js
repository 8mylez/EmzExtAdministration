import { cmsElements } from './cms-catalog.js';
import { configDescriptor, elementConfig, validateSlotConfig, validateLink } from './cms-config.js';
import { entityField, errorHtml } from '../entity-fields.js';
import { fieldValue, uuid } from '../entity-data.js';
import { encode, notify } from '../ui.js';

const widget = config => config.isComponent ? config : Ext.widget(config);

export async function editCmsElement(api, config, id, locked, onSaved, binding) {
    let slot; let entries = []; let saving = false; let loading = false; let languageId = binding?.languageId || config.languageId; let baseline;
    const canWrite = () => binding ? api.can(`${binding.entity}:update`) : !locked && api.can('cms_slot:update');
    const language = entityField(api, { name: 'language', label: 'Sprache', type: 'reference', required: true, reference: { entity: 'language' } }, languageId, true);
    const typeField = widget(entityField(api, { name: 'elementType', label: 'Elementtyp', type: 'select', options: cmsElements.map(element => [element.name, element.label]) }, null, true));
    const content = Ext.create('Ext.form.Panel', { border: false, bodyPadding: 20, scrollable: true, items: [] });
    const form = Ext.create('Ext.panel.Panel', { layout: 'fit', items: [content], tbar: [language, { text: 'Sprache laden', handler: () => reloadLanguage() }] });
    const dialog = Ext.create('Ext.window.Window', { title: binding ? 'Inhalt überschreiben' : 'Element bearbeiten', modal: true, constrain: true, layout: 'fit', width: Math.min(850, innerWidth - 24), height: Math.min(820, innerHeight - 32), items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Speichern', itemId: 'saveElement', cls: 'emz-admin__primary', handler: save }],
        listeners: { beforeclose: () => {
            if (saving || loading) return false;
            if (!dirty()) return true;
            Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Änderungen gehen verloren.', answer => { if (answer === 'yes') dialog.destroy(); }); return false;
        } },
    });
    typeField.on('change', (field, type, old) => {
        if (loading || !old || type === old) return;
        Ext.Msg.confirm('Elementtyp wechseln?', 'Die bisherige Konfiguration wird beim Speichern durch die Konfiguration des neuen Elementtyps ersetzt.', choice => {
            if (dialog.destroyed) return;
            if (choice === 'yes') renderFields(type, elementConfig(type));
            else { typeField.suspendEvents(); typeField.setValue(old); typeField.resumeEvents(); }
        });
    });
    dialog.show(); await load();

    function dirty() {
        if (!slot) return false;
        try { return JSON.stringify({ type: typeField.getValue(), config: values() }) !== baseline; } catch { return true; }
    }
    async function reloadLanguage() {
        if (saving || loading || !language.getValue()) return;
        if (dirty()) { Ext.Msg.confirm('Änderungen verwerfen?', 'Die neue Sprache wird ohne die ungespeicherten Änderungen geladen.', choice => { if (choice === 'yes') load(language.getValue()); }); return; }
        await load(language.getValue());
    }
    async function load(selectedLanguage = languageId) {
        loading = true; dialog.down('#saveElement').disable(); dialog.setLoading('Element wird geladen …');
        try {
            const response = await api.search('cms-slot', { ids: [id], limit: 1, associations: { block: { associations: { section: { associations: { page: {} } } } } } }, { headers: { 'sw-language-id': selectedLanguage } });
            if (dialog.destroyed) return;
            slot = response.data[0]; if (!slot) throw new Error('Dieses Element ist nicht mehr vorhanden.');
            languageId = selectedLanguage;
            const pageType = slot.block?.section?.page?.type;
            const types = cmsElements.filter(element => !element.allowedPageTypes || element.allowedPageTypes.includes(pageType));
            if (!types.some(element => element.name === slot.type)) types.push({ name: slot.type, label: slot.type });
            typeField.getStore().loadData(types.map(element => ({ value: element.name, label: element.label })));
            locked ||= slot.locked || slot.block?.locked || slot.block?.section?.locked || slot.block?.section?.page?.locked;
            const writable = canWrite();
            typeField.setReadOnly(Boolean(binding) || !writable || languageId !== config.languageId);
            typeField.setValue(slot.type);
            const overrides = binding ? await binding.load(languageId) : {};
            if (dialog.destroyed) return;
            renderFields(slot.type, { ...(slot.translated?.config || slot.config || {}), ...overrides }); baseline = JSON.stringify({ type: slot.type, config: values() });
            dialog.down('#saveElement').setDisabled(!writable);
        } catch (error) { if (!dialog.destroyed) content.add({ xtype: 'component', html: errorHtml(error) }); }
        finally { loading = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
    function renderFields(type, values) {
        const writable = canWrite();
        if (typeField.ownerCt) typeField.ownerCt.remove(typeField, false);
        content.removeAll(); entries = []; content.add(typeField);
        const defaults = elementConfig(type); const merged = { ...defaults, ...values };
        if (!Object.keys(merged).length) content.add({ xtype: 'component', html: '<p>Dieses Element übernimmt seinen Inhalt automatisch aus der aufgerufenen Shopseite.</p>' });
        for (const [name, initial] of Object.entries(merged)) {
            const description = configDescriptor(type, name, initial);
            const sourceOptions = [['static', 'Eigener Inhalt']];
            if (['content', 'media', 'previewMedia', 'product', 'products', 'sliderItems'].includes(name)) sourceOptions.push(['mapped', 'Dynamische Verknüpfung']);
            if (name === 'products') sourceOptions.push(['product_stream', 'Dynamische Produktgruppe']);
            if (!sourceOptions.some(([key]) => key === initial.source)) sourceOptions.push([initial.source, initial.source === 'default' ? 'Standard der Shopseite' : initial.source]);
            const source = widget(entityField(api, { name: `${name}-source`, label: `Quelle: ${description.label}`, type: 'select', options: sourceOptions }, initial.source || 'static', writable));
            const box = Ext.create('Ext.form.FieldSet', { title: encode(description.label), items: [source] });
            const entry = { name, description, initial, source, box, control: null, cache: { [source.getValue()]: initial.value } }; entries.push(entry); content.add(box);
            const renderValue = () => {
                if (entry.control) { entry.cache[entry.previousSource] = readValue(entry); box.remove(entry.control); }
                const selectedSource = source.getValue(); const initialValue = entry.cache[selectedSource] ?? (selectedSource === 'static' ? defaults[name]?.value : '');
                entry.previousSource = selectedSource;
                if (selectedSource === 'mapped' || selectedSource === 'default') {
                    const paths = mappingPaths(name);
                    entry.control = Ext.create('Ext.form.field.ComboBox', { fieldLabel: 'Verknüpftes Feld', labelAlign: 'top', anchor: '100%',
                        store: paths, queryMode: 'local', editable: true, forceSelection: false, value: initialValue,
                        readOnly: !writable, allowBlank: false });
                } else if (selectedSource === 'product_stream') entry.control = entityField(api, { name: 'stream', label: 'Dynamische Produktgruppe', required: true, type: 'reference', reference: { entity: 'product_stream' } }, initialValue, writable);
                else if (['gallery', 'sortings'].includes(description.type)) entry.control = collectionField(api, description.type, initialValue, writable);
                else entry.control = widget(entityField(api, description, name === 'filters' ? (initialValue || '').split(',').filter(Boolean) : initialValue, writable));
                box.add(entry.control);
            };
            source.on('change', renderValue); renderValue();
        }
        content.add({ xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' });
    }
    function readValue(entry) {
        const source = entry.previousSource; const value = entry.control.getValue();
        if (source !== 'static' || ['gallery', 'sortings'].includes(entry.description.type)) return value;
        const converted = fieldValue(entry.description, value); return entry.name === 'filters' ? converted.join(',') : converted;
    }
    function values() { return Object.fromEntries(entries.map(entry => [entry.name, { ...entry.initial, source: entry.source.getValue(), value: readValue(entry) }])); }
    async function save() {
        if (saving || loading || !canWrite() || !content.getForm().isValid()) return;
        saving = true; dialog.setLoading('Element wird gespeichert …');
        try {
            const value = validateSlotConfig(values());
            if (binding) await binding.save(value, languageId);
            else await api.request(`/cms-slot/${id}`, 'PATCH', { ...(typeField.getValue() !== slot.type ? { type: typeField.getValue() } : {}), config: value }, { headers: { 'sw-language-id': languageId } });
            dialog.destroy(); notify('Element gespeichert.'); onSaved?.();
        } catch (error) { if (!dialog.destroyed && api.user) content.down('#error').update(errorHtml(error)); }
        finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}

function mappingPaths(name) {
    if (['media', 'previewMedia'].includes(name)) return ['product.cover.media', 'product.manufacturer.media', 'category.media'];
    if (name === 'sliderItems') return ['product.media'];
    if (name === 'product') return ['product'];
    return ['product.name', 'product.description', 'product.productNumber', 'product.manufacturer.name', 'category.name', 'category.description'];
}

function collectionField(api, type, initial, writable) {
    const gallery = type === 'gallery';
    const records = gallery ? (initial || []).map(item => ({ ...item, id: uuid(), label: item.mediaId }))
        : Object.entries(initial || {}).map(([sortingId, priority]) => ({ id: uuid(), sortingId, priority, label: sortingId }));
    const store = Ext.create('Ext.data.Store', { fields: ['id', 'label', 'mediaId', 'url', 'newTab', 'sortingId', 'priority'], data: records });
    const grid = Ext.create('Ext.grid.Panel', { store, height: 250, anchor: '100%', columns: [
        { text: gallery ? 'Bild' : 'Sortierung', dataIndex: 'label', flex: 1, renderer: encode },
        gallery ? { text: 'Link', dataIndex: 'url', flex: 1, renderer: encode } : { text: 'Priorität', dataIndex: 'priority', width: 100 },
    ], tbar: [
        { text: gallery ? 'Bild hinzufügen' : 'Sortierung hinzufügen', disabled: !writable, handler: () => edit() },
        { text: 'Bearbeiten', disabled: !writable, handler: () => { const row = grid.getSelection()[0]; if (row) edit(row); } },
        { text: 'Entfernen', disabled: !writable, handler: () => store.remove(grid.getSelection()) },
        ...(gallery ? [-1, 1].map(offset => ({ text: offset < 0 ? 'Nach oben' : 'Nach unten', disabled: !writable, handler: () => {
            const row = grid.getSelection()[0]; const index = store.indexOf(row); if (!row || index + offset < 0 || index + offset >= store.getCount()) return;
            store.remove(row); store.insert(index + offset, row); grid.getSelectionModel().select(row);
        } })) : []),
    ], listeners: { afterrender: async () => {
        const ids = records.map(item => gallery ? item.mediaId : item.sortingId).filter(Boolean);
        if (!ids.length || !api.can(gallery ? 'media:read' : 'product_sorting:read')) return;
        try {
            for (let index = 0; index < ids.length; index += 100) {
                const result = await api.search(gallery ? 'media' : 'product-sorting', { ids: ids.slice(index, index + 100), limit: 100 });
                if (grid.destroyed) return;
                for (const item of result.data) store.each(row => { if (row.get(gallery ? 'mediaId' : 'sortingId') === item.id) row.set('label', item.fileName || item.label || item.id); });
            }
        } catch { /* Keep selected identifiers visible if labels cannot be loaded. */ }
    }, destroy: () => store.destroy() } });
    grid.getValue = () => gallery ? store.getRange().map(row => ({ mediaId: row.get('mediaId'), url: row.get('url') || '', newTab: Boolean(row.get('newTab')) }))
        : Object.fromEntries(store.getRange().map(row => [row.get('sortingId'), row.get('priority')]));
    function edit(row) {
        const description = { name: gallery ? 'mediaId' : 'sortingId', label: gallery ? 'Bild' : 'Sortierung', type: 'reference', required: true,
            reference: { entity: gallery ? 'media' : 'product_sorting', labelFields: [gallery ? 'fileName' : 'label'] } };
        const field = entityField(api, description, row?.get(description.name), true);
        const fields = gallery ? [{ name: 'url', label: 'Link' }, { name: 'newTab', label: 'In neuem Tab öffnen', type: 'boolean' }]
            : [{ name: 'priority', label: 'Priorität', type: 'integer', min: 0, default: 1, required: true }];
        const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, items: [field, ...fields.map(desc => entityField(api, desc, row?.get(desc.name), true)), { xtype: 'component', itemId: 'error', cls: 'emz-admin__error' }] });
        const dialog = Ext.create('Ext.window.Window', { title: gallery ? 'Galeriebild bearbeiten' : 'Sortierung bearbeiten', modal: true, constrain: true, width: Math.min(540, innerWidth - 24), items: [form],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Übernehmen', handler: () => {
                if (!form.getForm().isValid()) return;
                const values = form.getForm().getFieldValues();
                try {
                    if (gallery) validateLink(values.url);
                    else if (store.findBy(item => item !== row && item.get('sortingId') === values.sortingId) >= 0) throw new Error('Diese Sortierung ist bereits enthalten.');
                    values.label = field.getRawValue(); if (row) row.set(values); else store.add({ id: uuid(), ...values }); dialog.destroy();
                } catch (error) { form.down('#error').update(errorHtml(error)); }
            } }],
        }); dialog.show();
    }
    return grid;
}
