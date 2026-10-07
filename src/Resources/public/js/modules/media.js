import { entityListView } from '../entity-list.js';
import { entityField } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';
import { folderConfigPanel, moveMediaDialog } from './media-settings.js';

export const mediaModule = {
    id: 'media', title: 'Medien', singular: 'Medium', entity: 'media', group: 'Inhalte', icon: 'x-fa fa-images',
    search: ['fileName', 'title', 'alt'], sort: 'createdAt', direction: 'DESC', create: false, multiSelect: true,
    labelFields: ['fileName'],
    columns: [{ field: 'fileName', label: 'Dateiname' }, { field: 'title', label: 'Titel' }, { field: 'private', label: 'Privat', type: 'boolean', width: 80 },
        { field: 'mimeType', label: 'Dateityp', width: 180 }, { field: 'fileSize', label: 'Größe', width: 120, render: size => `${Math.ceil((size || 0) / 1024)} KB` },
        { field: 'createdAt', label: 'Hochgeladen', type: 'date', width: 170 }],
    fields: [
        { name: 'fileName', label: 'Dateiname', readOnly: true }, { name: 'title', label: 'Titel' }, { name: 'alt', label: 'Alternativtext' },
        { name: 'mediaFolderId', label: 'Ordner', type: 'reference', reference: { entity: 'media_folder' } },
    ],
    view: (api, config) => {
        const grid = entityListView(api, config, mediaModule);
        grid.addDocked({ xtype: 'toolbar', dock: 'top', items: [
            { text: 'Datei hochladen', ariaLabel: 'Datei hochladen', iconCls: 'x-fa fa-upload',
                disabled: !api.can('media:create') || !api.can('media:update'), handler: () => uploadDialog(api, () => grid.refreshRecords()) },
            { text: 'Datei öffnen', ariaLabel: 'Datei öffnen', handler: () => openMedia(api, grid.getSelection()[0]?.id) },
            { text: 'Umbenennen', ariaLabel: 'Umbenennen', disabled: !api.can('media:update'), handler: () => renameMedia(api, grid) },
            { text: 'Verschieben', disabled: !api.can('media:update') || !api.can('media_folder:read'), handler: () => moveMediaDialog(api, grid) },
        ] });
        return grid;
    },
};

export const mediaFoldersModule = {
    id: 'media-folders', title: 'Medienordner', singular: 'Medienordner', entity: 'media_folder', group: 'Inhalte', icon: 'x-fa fa-folder',
    search: ['name'], sort: 'name', direction: 'ASC', columns: [{ field: 'name', label: 'Ordner' }],
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'parentId', label: 'Übergeordneter Ordner', type: 'reference', reference: { entity: 'media_folder' } },
        { name: 'defaultFolderId', label: 'Standardordner für', type: 'reference', reference: { entity: 'media_default_folder', labelFields: ['entity'] } }],
    detailTabs: (api, config, folder) => api.can('media_folder_configuration:read') && api.can('media_thumbnail_size:read') ? [folderConfigPanel(api, folder)] : [],
    view: (api, config) => {
        let busy = false; const grid = entityListView(api, config, mediaFoldersModule);
        grid.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'Ordner auflösen', disabled: !['media_folder:delete', 'media_folder:update', 'media:update', 'media_folder_configuration:delete'].every(privilege => api.can(privilege)), handler: () => {
            const record = grid.getSelection()[0]?.get('raw'); if (!record || busy) { if (!record) notify('Bitte einen Ordner auswählen.'); return; }
            if (record.defaultFolderId) { showError(new Error('Die Zuordnung als Standardordner bitte zuerst aufheben.')); return; }
            Ext.Msg.confirm('Ordner auflösen?', `Dateien und Unterordner aus „${encode(record.name)}“ werden eine Ebene nach oben verschoben. Der leere Ordner wird entfernt.`, async answer => {
                if (answer !== 'yes' || busy || grid.destroyed) return; busy = true; grid.setLoading('Ordner wird aufgelöst …');
                try { await api.request(`/_action/media-folder/${record.id}/dissolve`, 'POST', {}); await grid.refreshRecords(); notify('Ordner aufgelöst. Dateien und Unterordner bleiben erhalten.'); }
                catch (error) { if (api.user) showError(error); }
                finally { busy = false; if (!grid.destroyed) grid.setLoading(false); }
            });
        } }] }); return grid;
    },
    prepare: async (payload, original, { api }) => {
        if (payload.parentId) {
            let parentId = payload.parentId; const seen = new Set(original ? [original.id] : []);
            while (parentId) {
                if (seen.has(parentId)) throw new Error('Ein Ordner darf nicht sich selbst oder einem Unterordner untergeordnet werden.');
                seen.add(parentId); const parent = (await api.search('media-folder', { ids: [parentId], limit: 1 })).data[0];
                if (!parent) throw new Error('Der übergeordnete Ordner ist nicht mehr vorhanden.'); parentId = parent.parentId;
            }
        }
        if (payload.defaultFolderId) {
            const assigned = await api.search('media-folder', { limit: 1, filter: [{ type: 'equals', field: 'defaultFolderId', value: payload.defaultFolderId },
                ...(original ? [{ type: 'not', operator: 'AND', queries: [{ type: 'equals', field: 'id', value: original.id }] }] : [])] });
            if (assigned.total) throw new Error('Dieser Standardordner ist bereits einem anderen Ordner zugeordnet. Bitte die bisherige Zuordnung zuerst aufheben.');
        }
        if (!original) {
            payload.useParentConfiguration = Boolean(payload.parentId);
            if (payload.parentId) payload.configurationId = (await api.search('media-folder', { ids: [payload.parentId], limit: 1 })).data[0].configurationId;
            else {
                payload.configuration = { id: uuid(), createThumbnails: true, keepAspectRatio: true, thumbnailQuality: 80 };
                payload.configurationId = payload.configuration.id;
            }
        }
        return payload;
    },
};

export async function uploadDialog(api, onSaved, { privateFile = false } = {}) {
    let folderId = null;
    if (privateFile) {
        try {
            const folders = await api.search('media-default-folder', { limit: 1, filter: [{ type: 'equals', field: 'entity', value: 'product_download' }], associations: { folder: {} } });
            folderId = folders.data[0]?.folder?.id;
            if (!folderId) throw new Error('Der Shopware-Ordner für Produkt-Downloads ist nicht eingerichtet.');
        } catch (error) { if (api.user) showError(error); return; }
    }
    if (!api.user) return;
    const folder = privateFile ? Ext.create('Ext.form.field.Display', { fieldLabel: 'Ordner', value: 'Geschützte Produkt-Downloads' })
        : entityField(api, { name: 'folder', label: 'Ordner', type: 'reference', reference: { entity: 'media_folder' } }, null, true);
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, items: [
        { xtype: 'filefield', name: 'file', fieldLabel: 'Datei', labelAlign: 'top', buttonText: 'Dateien auswählen', allowBlank: false, anchor: '100%',
            listeners: { afterrender: field => field.fileInputEl.dom.setAttribute('multiple', 'multiple') } }, folder,
        { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' },
    ] });
    let uploading = false;
    let pendingFiles;
    let completed = 0;
    const dialog = Ext.create('Ext.window.Window', {
        title: 'Datei hochladen', modal: true, width: Math.min(560, window.innerWidth - 24), layout: 'fit', items: [form],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Hochladen', cls: 'emz-admin__primary', handler: upload }],
        listeners: { beforeclose: () => !uploading },
    });
    dialog.show();
    async function upload() {
        if (uploading || !form.getForm().isValid()) return;
        pendingFiles ||= Array.from(form.getForm().findField('file').fileInputEl.dom.files);
        if (!pendingFiles.length) return;
        if (pendingFiles.some(file => file.name.lastIndexOf('.') <= 0)) { form.down('#error').update('Bitte nur Dateien mit Dateiendung auswählen.'); pendingFiles = null; return; }
        let id;
        let created = false;
        uploading = true;
        dialog.setLoading('Datei wird hochgeladen …');
        try {
            form.getForm().getFields().each(field => field.disable());
            for (const file of pendingFiles.slice(completed)) {
                dialog.setLoading(`Datei ${completed + 1} von ${pendingFiles.length} wird hochgeladen …`); id = uuid(); created = false;
                await api.request('/media', 'POST', { id, mediaFolderId: folderId || folder.getValue() || null, private: privateFile });
                created = true; const dot = file.name.lastIndexOf('.');
                const query = new URLSearchParams({ extension: file.name.slice(dot + 1), fileName: file.name.slice(0, dot) });
                await api.request(`/_action/media/${id}/upload?${query}`, 'POST', file,
                    { rawBody: true, contentType: file.type === 'application/json' ? 'text/plain' : file.type || 'application/octet-stream' });
                await onSaved(id); completed++; created = false;
            }
            dialog.destroy();
            notify(`${completed} Datei(en) hochgeladen.`);
        } catch (error) {
            if (created && api.user && api.can('media:delete')) {
                try { await api.request(`/media/${id}`, 'DELETE'); } catch { /* Keep the empty media record visible for manual cleanup. */ }
            }
            if (!dialog.destroyed && api.user) form.down('#error').update(encode(`${completed} Datei(en) hochgeladen. ${error.message}`));
        } finally { uploading = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}

export async function openMedia(api, id) {
    if (!id) { notify('Bitte zuerst eine Datei auswählen.'); return; }
    try {
        const response = await api.search('media', { ids: [id], limit: 1 });
        const media = response.data[0];
        if (media?.private) {
            const prepared = await api.request(`/_action/media/${id}/download/prepare`);
            const link = document.createElement('a');
            if (prepared.type === 'external') {
                const url = new URL(prepared.url, location.origin);
                if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Die Datei-URL ist ungültig.');
                link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
            } else {
                const blob = await api.request(`/_action/media/${id}/download`, 'GET', undefined, { responseType: 'blob' });
                link.href = URL.createObjectURL(blob); link.download = `${media.fileName}.${media.fileExtension}`;
                setTimeout(() => URL.revokeObjectURL(link.href), 30000);
            }
            link.click(); return;
        }
        if (!media?.url) throw new Error('Für dieses Medium ist keine Datei verfügbar.');
        const url = new URL(media.url, location.origin);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Die Datei-URL ist ungültig.');
        const dialog = Ext.create('Ext.window.Window', {
            title: encode(media.fileName || 'Datei'), modal: true, width: Math.min(800, window.innerWidth - 24),
            height: Math.min(640, window.innerHeight - 32), scrollable: true, bodyPadding: 20,
            html: `${media.mimeType?.startsWith('image/') ? `<img class="emz-admin__media-preview" src="${encode(url.href)}" alt="${encode(media.alt || '')}">` : ''}<p><a href="${encode(url.href)}" target="_blank" rel="noopener noreferrer">Datei in neuem Tab öffnen</a></p>`,
        });
        if (api.user) dialog.show(); else dialog.destroy();
    } catch (error) { if (api.user) showError(error); }
}

function renameMedia(api, grid) {
    const record = grid.getSelection()[0];
    if (!record) { notify('Bitte zuerst eine Datei auswählen.'); return; }
    Ext.Msg.prompt('Datei umbenennen', 'Neuer Dateiname ohne Dateiendung:', async (choice, value) => {
        if (choice !== 'ok' || !value.trim()) return;
        try {
            await api.request(`/_action/media/${record.id}/rename`, 'POST', { fileName: value.trim() });
            if (!grid.destroyed) grid.refreshRecords();
        } catch (error) { if (api.user) showError(error); }
    }, null, false, record.get('fileName'));
}
