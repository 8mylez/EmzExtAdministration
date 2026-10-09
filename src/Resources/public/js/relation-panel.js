import { entityListView } from './entity-list.js';
import { entityField } from './entity-fields.js';
import { entityPath, recordLabel } from './entity-data.js';
import { encode, showError } from './ui.js';

export function relationPanel(api, config, owner, relation) {
    const { title, entity, reverse, mapping, association, defaultField } = relation;
    const labelFields = relation.labelFields || ['name'];
    const ownerPath = `/${entityPath(owner.entity)}/${owner.id}`;
    const canWrite = api.can(`${owner.entity}:update`) && !owner.readOnly;
    const panel = entityListView(api, config, { title, singular: 'Zuordnung', entity, create: false, delete: false,
        search: relation.search || labelFields, sort: labelFields[0], direction: 'ASC', labelFields,
        filter: [{ type: 'equals', field: `${reverse}.id`, value: owner.id }],
        fields: labelFields.map(name => ({ name, label: name, readOnly: true })),
        columns: relation.columns || [{ field: labelFields[0], label: title, render: (value, record) => recordLabel(record, { labelFields }) }],
    }); panel.setTitle(title);
    let removing = false;
    panel.addDocked({ xtype: 'toolbar', dock: 'top', items: [
        { text: 'Zuordnen', disabled: !canWrite || !api.can(`${mapping}:create`), handler: assign },
        { text: 'Zuordnung entfernen', disabled: !canWrite || !api.can(`${mapping}:delete`), handler: () => {
            const selected = panel.getSelection()[0]; if (!selected || removing) return;
            Ext.Msg.confirm('Zuordnung entfernen?', `„${encode(recordLabel(selected.get('raw'), { labelFields }))}“ wird nicht mehr zugeordnet.`, async choice => {
                if (choice !== 'yes' || panel.destroyed || removing) return;
                removing = true; panel.setLoading('Zuordnung wird entfernt …');
                try {
                    if (defaultField) {
                        const current = (await api.search(entityPath(owner.entity), { ids: [owner.id], limit: 1 })).data[0];
                        if (current?.[defaultField] === selected.id) throw new Error('Der Standardwert kann nicht entfernt werden. Bitte zunächst einen anderen Standardwert speichern.');
                    }
                    const route = association.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
                    await api.request(`${ownerPath}/${route}/${selected.id}`, 'DELETE');
                    if (!panel.destroyed) await panel.refreshRecords();
                } catch (error) { if (api.user) showError(error); }
                finally { removing = false; if (!panel.destroyed) panel.setLoading(false); }
            });
        } },
    ] });
    function assign() {
        const field = entityField(api, { name: 'id', label: title, required: true, type: 'reference', reference: { entity, labelFields, search: relation.search, filter: relation.filter } }, null, true);
        let saving = false;
        const dialog = Ext.create('Ext.window.Window', { title: `${title} zuordnen`, modal: true, width: Math.min(570, window.innerWidth - 24), bodyPadding: 20, layout: 'anchor', items: [field],
            buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Zuordnen', cls: 'emz-admin__primary', handler: async () => {
                if (saving || !field.isValid()) return;
                saving = true; dialog.setLoading('Zuordnung wird gespeichert …');
                try { await api.request(ownerPath, 'PATCH', { [association]: [{ id: field.getValue() }] }); dialog.destroy(); if (!panel.destroyed) panel.refreshRecords(); }
                catch (error) { if (api.user) showError(error); }
                finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
            } }], listeners: { beforeclose: () => !saving },
        }); dialog.show();
    }
    return panel;
}
