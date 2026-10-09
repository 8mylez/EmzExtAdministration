import { entityField, formValues } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';

export function folderConfigPanel(api, folder) {
    const writable = api.can('media_folder:update') && api.can('media_folder_configuration:create') && api.can('media_folder_configuration_media_thumbnail_size:create');
    const fields = [
        { name: 'createThumbnails', label: 'Vorschaubilder erzeugen', type: 'boolean' }, { name: 'keepAspectRatio', label: 'Seitenverhältnis beibehalten', type: 'boolean' },
        { name: 'thumbnailQuality', label: 'Bildqualität (%)', type: 'integer', min: 0, max: 100, required: true },
        { name: 'mediaThumbnailSizes', label: 'Vorschaubildgrößen', type: 'reference', multiple: true, reference: { entity: 'media_thumbnail_size', labelFields: ['width', 'height'] } },
    ];
    let original; let currentFolder; let loading = false; let saving = false;
    const form = Ext.create('Ext.form.Panel', { title: 'Ordner-Einstellungen', bodyPadding: 20, scrollable: true, bbar: [{ text: 'Ordner-Einstellungen speichern', disabled: !writable, handler: save }], listeners: { afterrender: load } });
    async function load() {
        loading = true; form.setLoading('Ordner-Einstellungen werden geladen …');
        try {
            currentFolder = (await api.search('media-folder', { ids: [folder.id], limit: 1, associations: { configuration: { associations: { mediaThumbnailSizes: { limit: 500 } } } } })).data[0];
            if (form.destroyed) return;
            if (!currentFolder) throw new Error('Der Ordner ist nicht mehr vorhanden.'); original = currentFolder.configuration;
            form.removeAll(true);
            const inherit = Ext.create('Ext.form.field.Checkbox', { name: 'inherit', boxLabel: 'Einstellungen des übergeordneten Ordners verwenden', checked: currentFolder.useParentConfiguration && Boolean(currentFolder.parentId), disabled: !writable || !currentFolder.parentId,
                listeners: { change: (checkbox, checked) => fields.forEach(description => form.getForm().findField(description.name)?.setDisabled(!writable || checked)) } });
            form.add(inherit); form.add(fields.map(description => {
                const control = entityField(api, description, description.name === 'mediaThumbnailSizes' ? (original?.mediaThumbnailSizes || []).map(size => size.id) : original?.[description.name], writable);
                const field = control.isComponent ? control : Ext.widget(control); field.setDisabled(!writable || inherit.getValue()); return field;
            }));
            form.add({ xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' });
            form.getForm().getFields().each(field => field.resetOriginalValue());
        } catch (error) { if (!form.destroyed && api.user) showError(error); }
        finally { loading = false; if (!form.destroyed) form.setLoading(false); }
    }
    async function save() {
        if (saving || loading || !writable || !form.getForm().isValid() || !form.getForm().isDirty()) return;
        saving = true; form.setLoading('Ordner-Einstellungen werden gespeichert …');
        try {
            const oldConfigurationId = currentFolder.configurationId;
            const inherit = form.getForm().findField('inherit').getValue();
            if (inherit) {
                const parent = (await api.search('media-folder', { ids: [currentFolder.parentId], limit: 1 })).data[0];
                if (!parent) throw new Error('Der übergeordnete Ordner ist nicht mehr vorhanden.');
                await api.request(`/media-folder/${folder.id}`, 'PATCH', { useParentConfiguration: true, configurationId: parent.configurationId });
            } else {
                const { values } = formValues(form, fields);
                // A distinct configuration prevents edits from changing a shared parent or sibling configuration.
                await api.request(`/media-folder/${folder.id}`, 'PATCH', { useParentConfiguration: false, configuration: { id: uuid(), createThumbnails: values.createThumbnails,
                    keepAspectRatio: values.keepAspectRatio, thumbnailQuality: values.thumbnailQuality, private: original?.private || false, noAssociation: original?.noAssociation || false,
                    mediaThumbnailSizes: values.mediaThumbnailSizes.map(id => ({ id })) } });
            }
            await load(); notify('Ordner-Einstellungen gespeichert.');
            if (oldConfigurationId && oldConfigurationId !== currentFolder.configurationId && api.can('media_folder_configuration:delete')) {
                const referenced = await api.search('media-folder', { limit: 1, filter: [{ type: 'equals', field: 'configurationId', value: oldConfigurationId }] });
                if (!referenced.total) await api.request(`/media-folder-configuration/${oldConfigurationId}`, 'DELETE');
            }
        } catch (error) { if (!form.destroyed && api.user) form.down('#error')?.update(encode(error.message)); }
        finally { saving = false; if (!form.destroyed) form.setLoading(false); }
    }
    form.hasUnsavedChanges = () => saving || form.getForm().isDirty();
    return form;
}

export function moveMediaDialog(api, grid) {
    const ids = grid.getSelection().map(row => row.id);
    if (!ids.length) { notify('Bitte Dateien auswählen.'); return; }
    let saving = false;
    const folder = entityField(api, { name: 'folder', label: 'Zielordner (leer = Hauptverzeichnis)', type: 'reference', reference: { entity: 'media_folder' } }, null, true);
    const dialog = Ext.create('Ext.window.Window', { title: 'Medien verschieben', width: Math.min(560, innerWidth - 24), modal: true, constrain: true, bodyPadding: 20, layout: 'anchor', items: [
        { xtype: 'component', html: `<p>${ids.length} ausgewählte Dateien verschieben.</p>` }, folder,
    ], buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Verschieben', cls: 'emz-admin__primary', handler: async () => {
        if (saving) return; saving = true; dialog.setLoading('Dateien werden verschoben …');
        try {
            const records = (await api.search('media', { ids, limit: ids.length })).data;
            if (records.some(record => record.private)) throw new Error('Geschützte Download-Dateien bleiben in ihrem privaten Ordner.');
            await api.request('/_action/sync', 'POST', { 'move-media': { action: 'upsert', entity: 'media', payload: ids.map(id => ({ id, mediaFolderId: folder.getValue() || null })) } });
            dialog.destroy(); grid.refreshRecords(); notify('Dateien verschoben.');
        } catch (error) { if (api.user) showError(error); }
        finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
    } }], listeners: { beforeclose: () => !saving } }); dialog.show();
}

export const thumbnailSizesModule = { id: 'thumbnail-sizes', title: 'Vorschaubildgrößen', singular: 'Vorschaubildgröße', entity: 'media_thumbnail_size', group: 'Einstellungen',
    search: [], sort: 'width', direction: 'ASC', associations: { mediaFolderConfigurations: { limit: 1 } }, isDeleteLocked: record => Boolean(record.mediaFolderConfigurations?.length),
    columns: [{ field: 'width', label: 'Breite (Pixel)' }, { field: 'height', label: 'Höhe (Pixel)' }],
    fields: [{ name: 'width', label: 'Breite (Pixel)', type: 'integer', min: 1, required: true }, { name: 'height', label: 'Höhe (Pixel)', type: 'integer', min: 1, required: true }],
};
