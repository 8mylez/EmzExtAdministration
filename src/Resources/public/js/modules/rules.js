import { entityField, formValues, errorHtml } from '../entity-fields.js';
import { entityPayload, uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';
import { conditionChanges, conditionFields, conditionLabels } from './rule-data.js';

export const ruleModule = {
    id: 'rules', title: 'Rule Builder', singular: 'Regel', entity: 'rule', group: 'Automatisierung', icon: 'x-fa fa-code-branch',
    search: ['name', 'description'], sort: 'priority', direction: 'DESC',
    columns: [{ field: 'name', label: 'Regel' }, { field: 'priority', label: 'Priorität', width: 110 }, { field: 'invalid', label: 'Ungültig', type: 'boolean', width: 110 }],
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'priority', label: 'Priorität', type: 'integer', default: 0, required: true },
        { name: 'description', label: 'Beschreibung', type: 'textarea' }],
    editor: openRuleEditor,
};

async function loadConditions(api, id) {
    const records = [];
    let page = 1;
    while (true) {
        const response = await api.search('rule-condition', { limit: 100, page, 'total-count-mode': 1,
            filter: [{ type: 'equals', field: 'ruleId', value: id }], sort: [{ field: 'id', order: 'ASC' }] });
        records.push(...response.data);
        if (records.length >= response.total || !response.data.length) return records;
        page++;
    }
}

async function openRuleEditor(api, config, definition, id, onSaved) {
    let original, originalConditions, schemas;
    try {
        [original, originalConditions, schemas] = await Promise.all([
            id ? api.search('rule', { ids: [id], limit: 1 }).then(result => result.data[0]) : Promise.resolve(null),
            id && api.can('rule_condition:read') ? loadConditions(api, id) : Promise.resolve([]),
            api.request('/_info/rule-config'),
        ]);
        if (id && !original) throw new Error('Diese Regel ist nicht mehr vorhanden.');
    } catch (error) { if (api.user) showError(error); return; }
    if (!api.user) return;
    const writable = api.can(`rule:${id ? 'update' : 'create'}`);
    const canEditConditions = writable && ['read', 'create', 'update', 'delete'].every(action => api.can(`rule_condition:${action}`));
    let conditions = structuredClone(originalConditions);
    if (!id) conditions = [{ id: uuid(), type: 'andContainer', parentId: null, value: {}, position: 0 }];
    let saving = false;
    let changedConditions = false;
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 16, border: false, scrollable: true, region: 'west', split: true, width: 300,
        items: definition.fields.map(field => entityField(api, field, original?.[field.name], writable)) });
    const tree = Ext.create('Ext.tree.Panel', { region: 'center', title: 'Bedingungen', rootVisible: false, useArrows: true,
        store: Ext.create('Ext.data.TreeStore', { root: { expanded: true, children: [] } }),
        columns: [{ xtype: 'treecolumn', text: 'Bedingung', dataIndex: 'text', flex: 1, renderer: value => encode(value) }],
        tbar: { enableOverflow: true, items: [
            { text: 'Bedingung hinzufügen', disabled: !canEditConditions, handler: () => editCondition() },
            { text: 'Gruppe hinzufügen', disabled: !canEditConditions, menu: [
                { text: 'UND-Gruppe', handler: () => addGroup('andContainer') }, { text: 'ODER-Gruppe', handler: () => addGroup('orContainer') },
            ] },
            { text: 'Bearbeiten', disabled: !canEditConditions, handler: () => editCondition(selected()) },
            { text: 'Entfernen', disabled: !canEditConditions, handler: removeCondition },
        ] },
        listeners: { itemdblclick: () => { if (canEditConditions) editCondition(selected()); } },
    });
    const error = Ext.create('Ext.Component', { region: 'south', cls: 'emz-admin__error', ariaRole: 'alert' });
    const dialog = Ext.create('Ext.window.Window', { title: `Regel ${id ? 'bearbeiten' : 'anlegen'}`, modal: true, constrain: true,
        width: Math.min(1080, window.innerWidth - 24), height: Math.min(730, window.innerHeight - 32), layout: 'border', items: [form, tree, error],
        buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Speichern', disabled: !writable || (!id && !canEditConditions), cls: 'emz-admin__primary', handler: save }],
        listeners: { beforeclose: () => {
            if (saving) return false;
            if (!changedConditions && !form.getForm().isDirty()) return true;
            Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Änderungen gehen verloren.', answer => { if (answer === 'yes') dialog.destroy(); });
            return false;
        } },
    });
    form.getForm().getFields().each(field => field.resetOriginalValue());
    refreshTree();
    dialog.show();

    function selected() { return conditions.find(condition => condition.id === tree.getSelection()[0]?.id); }
    function isGroup(condition) { return ['andContainer', 'orContainer'].includes(condition?.type); }
    function parent() {
        const node = selected();
        if (isGroup(node)) return node;
        return conditions.find(condition => condition.id === node?.parentId) || conditions.find(condition => !condition.parentId);
    }
    function refreshTree(selectId) {
        const nodes = new Map(conditions.map(condition => [condition.id, { id: condition.id,
            text: [conditionLabels[condition.type] || 'Bedingung aus einer Erweiterung', condition.value?.operator,
                ...Object.entries(condition.value || {}).filter(([key]) => key !== 'operator').map(([, value]) =>
                    Array.isArray(value) ? `${value.length} ausgewählt` : typeof value === 'boolean' ? value ? 'Ja' : 'Nein' : String(value ?? ''))].filter(Boolean).join(' · '),
            expanded: true, children: [], leaf: !isGroup(condition) }]));
        const roots = [];
        for (const condition of [...conditions].sort((a, b) => a.position - b.position)) {
            const ancestor = nodes.get(condition.parentId);
            if (ancestor) { ancestor.children.push(nodes.get(condition.id)); ancestor.leaf = false; }
            else roots.push(nodes.get(condition.id));
        }
        tree.getStore().setRoot({ expanded: true, children: roots });
        if (selectId) tree.getSelectionModel().select(tree.getStore().getNodeById(selectId));
    }
    function append(type, value) {
        const ancestor = parent();
        if (ancestor && !isGroup(ancestor)) throw new Error('Bitte zuerst eine UND- oder ODER-Gruppe auswählen.');
        const condition = { id: uuid(), type, value, parentId: ancestor?.id || null,
            position: Math.max(-1, ...conditions.filter(item => item.parentId === (ancestor?.id || null)).map(item => item.position || 0)) + 1 };
        conditions.push(condition); changedConditions = true; refreshTree(condition.id);
    }
    function addGroup(type) { append(type, {}); }
    function removeCondition() {
        const node = selected();
        if (!node) return;
        if (!node.parentId) { Ext.Msg.alert('Hauptgruppe', 'Die Hauptgruppe kann nicht entfernt werden.'); return; }
        Ext.Msg.confirm('Bedingung entfernen?', 'Diese Bedingung und ihre untergeordneten Bedingungen werden beim Speichern entfernt.', answer => {
            if (answer !== 'yes' || dialog.destroyed) return;
            const removed = new Set([node.id]);
            let previous;
            do { previous = removed.size; for (const item of conditions) if (removed.has(item.parentId)) removed.add(item.id); } while (previous !== removed.size);
            conditions = conditions.filter(item => !removed.has(item.id)); changedConditions = true; refreshTree(node.parentId);
        });
    }
    function editCondition(condition) {
        if (condition && !schemas[condition.type] && !isGroup(condition)) {
            Ext.Msg.alert('Bedingung beibehalten', 'Diese spezielle Bedingung bleibt unverändert. Sie kann in der Shopware-Administration bearbeitet werden.'); return;
        }
        const group = isGroup(condition);
        const choices = group ? ['andContainer', 'orContainer'] : Object.keys(schemas).sort((a, b) => (conditionLabels[a] || a).localeCompare(conditionLabels[b] || b, 'de'));
        const typeField = Ext.widget(entityField(api, { name: 'conditionType', label: 'Bedingung', type: 'select', required: true,
            options: choices.map(type => [type, conditionLabels[type] || type]) }, condition?.type || null, true));
        const valuesForm = Ext.create('Ext.form.Panel', { border: false });
        let fields = [];
        const editor = Ext.create('Ext.window.Window', { title: 'Bedingung bearbeiten', modal: true, constrain: true, scrollable: true,
            width: Math.min(590, window.innerWidth - 24), maxHeight: window.innerHeight - 48, bodyPadding: 20,
            items: [typeField, valuesForm], buttons: [{ text: 'Abbrechen', handler: () => editor.close() }, { text: 'Übernehmen', handler: () => {
                if (!typeField.isValid() || !valuesForm.getForm().isValid()) return;
                try {
                    const { values } = formValues(valuesForm, fields);
                    const value = { ...(condition?.type === typeField.getValue() ? condition.value : {}), ...entityPayload({ fields }, values) };
                    for (const field of fields) if (field.required && Array.isArray(value[field.name]) && !value[field.name].length) throw new Error('Bitte mindestens einen Wert auswählen.');
                    if (condition) { condition.type = typeField.getValue(); condition.value = value; changedConditions = true; refreshTree(condition.id); }
                    else append(typeField.getValue(), value);
                    editor.destroy();
                } catch (failure) { showError(failure); }
            } }] });
        function populate(type) {
            valuesForm.removeAll(true); fields = conditionFields(schemas[type] || {});
            valuesForm.add(fields.map(field => entityField(api, field, condition?.type === type ? condition.value?.[field.name] : undefined, true)));
        }
        typeField.on('change', (field, type) => populate(type));
        if (condition) populate(condition.type);
        editor.show();
    }
    async function save() {
        if (saving || !writable || !form.getForm().isValid()) return;
        saving = true; dialog.setLoading('Regel wird gespeichert …');
        try {
            const { values, dirty } = formValues(form, definition.fields);
            const ruleId = id || uuid();
            const payload = { id: ruleId, ...entityPayload(definition, values, original, dirty) };
            const operations = { rule: { action: 'upsert', entity: 'rule', payload: [payload] } };
            if (changedConditions || !id) {
                if (!canEditConditions) throw new Error('Keine Berechtigung zum Bearbeiten der Bedingungen.');
                const changes = conditionChanges(originalConditions, conditions);
                if (changes.upsert.length) payload.conditions = changes.upsert;
                if (changes.delete.length) operations.removeConditions = { action: 'delete', entity: 'rule_condition', payload: changes.delete };
            }
            await api.request('/_action/sync', 'POST', operations);
            dialog.destroy(); notify('Regel gespeichert.'); onSaved?.(ruleId);
        } catch (failure) { if (!dialog.destroyed && api.user) error.update(errorHtml(failure)); }
        finally { saving = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}
