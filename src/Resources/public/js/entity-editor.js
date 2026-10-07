import { entityField, errorHtml, formValues } from './entity-fields.js';
import { entityPath, entityPayload, uuid, valueAt } from './entity-data.js';
import { notify, showError } from './ui.js';
import { recordContentTabs } from './record-content.js';

export async function openEntityEditor(api, config, definition, id, onSaved) {
    const entity = entityPath(definition.entity);
    let record;
    try {
        if (id) {
            const response = await api.search(entity, { ids: [id], limit: 1,
                ...(definition.editAssociations ? { associations: definition.editAssociations } : {}) });
            record = response.data[0];
            if (!record) throw new Error('Dieser Eintrag ist nicht mehr vorhanden. Bitte die Liste aktualisieren.');
        }
    } catch (error) { if (api.user) showError(error); return; }
    if (!api.user) return;
    const canWrite = api.can(`${definition.entity}:${id ? 'update' : 'create'}`)
        && !definition.isLocked?.(record)
        && definition.fields.some(field => !field.readOnly && !(id && field.createOnly));
    const defaults = typeof definition.defaults === 'function' ? definition.defaults(config) : definition.defaults || {};
    const initial = record || defaults;
    const fields = definition.fields.filter(field => !(id && field.createOnly) && !(!id && field.editOnly));
    const groups = [...new Set(fields.map(field => field.group || 'Allgemein'))];
    const groupedItems = groups.map(group => ({
        xtype: definition.groupTabs ? 'panel' : 'fieldset', title: definition.groupTabs && group === 'Allgemein' ? 'Stammdaten' : group,
        ...(definition.groupTabs ? { bodyPadding: 20, scrollable: true } : { collapsible: groups.length > 1 }),
        items: fields.filter(field => (field.group || 'Allgemein') === group)
            .map(field => entityField(api, field, field.initialValue ? field.initialValue(initial) : valueAt(initial, field.name), canWrite)),
    }));
    const error = { xtype: 'component', itemId: 'error', ariaRole: 'alert', cls: 'emz-admin__error' };
    const form = Ext.create('Ext.form.Panel', {
        border: false,
        ...(definition.groupTabs ? { layout: 'fit', items: [{ xtype: 'tabpanel', items: groupedItems }], dockedItems: [{ ...error, dock: 'bottom' }] }
            : { bodyPadding: 20, scrollable: true, items: [...groupedItems, error] }),
    });
    const extraTabs = record && definition.detailTabs ? definition.detailTabs(api, config, record) : [];
    if (record) {
        try { extraTabs.push(...await recordContentTabs(api, config, definition, record)); }
        catch (error) { if (api.user) showError(error); }
    }
    if (!api.user) { form.destroy(); extraTabs.forEach(tab => tab.destroy()); return; }
    if (extraTabs.length) form.setTitle('Allgemein');
    let saving = false;
    const dialog = Ext.create('Ext.window.Window', {
        title: `${definition.singular} ${id ? 'bearbeiten' : 'anlegen'}`, modal: true, layout: 'fit', constrain: true,
        width: Math.min(definition.editorWidth || (extraTabs.length > 5 ? 1040 : 760), window.innerWidth - 24),
        height: Math.min(780, window.innerHeight - 32), items: extraTabs.length ? [{ xtype: 'tabpanel', ...(extraTabs.length > 5 ? { tabPosition: 'left', tabRotation: 0, tabBar: { width: 180 } } : {}), items: [form, ...extraTabs] }] : [form],
        buttons: [
            { text: 'Abbrechen', handler: () => dialog.close() },
            { text: 'Speichern', ariaLabel: 'Speichern', cls: 'emz-admin__primary', disabled: !canWrite, handler: save },
        ],
        listeners: { beforeclose: () => {
            if (saving || extraTabs.some(tab => tab.isSaving?.())) return false;
            if (!form.getForm().isDirty() && !extraTabs.some(tab => tab.hasUnsavedChanges?.())) return true;
            Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Änderungen gehen verloren.', choice => {
                if (choice === 'yes') dialog.destroy();
            });
            return false;
        } },
    });
    form.getForm().getFields().each(field => field.resetOriginalValue());
    dialog.show();

    async function save() {
        if (saving || !canWrite || !form.getForm().isValid()) return;
        if (extraTabs.some(tab => tab.hasUnsavedChanges?.() || tab.isSaving?.())) { showError(new Error('Bitte die Änderungen in den weiteren Reitern zuerst dort speichern und laufende Vorgänge abwarten.')); return; }
        saving = true;
        dialog.setLoading('Eintrag wird gespeichert …');
        try {
            const { values, dirty } = formValues(form, fields);
            let payload = entityPayload(definition, values, record, dirty);
            const recordId = id || uuid();
            if (!id) payload = { ...defaults, ...payload, id: recordId };
            if (definition.prepare) payload = await definition.prepare(payload, record, { api, config, values });
            if (Object.keys(payload).length) {
                const path = id ? `/${entity}/${id}` : `/${entity}`;
                const method = id ? 'PATCH' : 'POST';
                if (definition.write) await definition.write(api, path, method, payload);
                else await api.request(path, method, payload);
            }
            dialog.destroy();
            notify(`${definition.singular} gespeichert.`);
            onSaved?.(recordId);
        } catch (error) {
            if (!dialog.destroyed && api.user) form.down('#error').update(errorHtml(error));
        } finally {
            saving = false;
            if (!dialog.destroyed) dialog.setLoading(false);
        }
    }
}
