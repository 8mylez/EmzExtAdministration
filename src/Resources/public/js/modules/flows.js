import { entityListView } from '../entity-list.js';
import { openEntityEditor } from '../entity-editor.js';
import { entityField } from '../entity-fields.js';
import { encode, showError } from '../ui.js';
import { additionalActions, flowActionFields, prepareFlowAction } from './flow-actions.js';
import { buildFlowTree } from './flow-tree.js';

const f = (name, label, options = {}) => ({ name, label, ...options });
const ref = (name, label, entity, extra = {}) => f(name, label, { type: 'reference', reference: { entity }, ...extra });
const bool = (name, label) => f(name, label, { type: 'boolean' });
const tagFields = [ref('config.tagIds', 'Tags', 'tag', { required: true, multiple: true, initialValue: record => Object.keys(record.config?.tagIds || {}) })];
const codeFields = [f('config.affiliateCode.value', 'Partnercode'), bool('config.affiliateCode.upsert', 'Vorhandenen Partnercode überschreiben'),
    f('config.campaignCode.value', 'Kampagnencode'), bool('config.campaignCode.upsert', 'Vorhandenen Kampagnencode überschreiben')];
const actions = {
    ...additionalActions,
    'action.stop.flow': { label: 'Flow beenden', fields: [] },
    'action.add.order.tag': { label: 'Bestellungs-Tags hinzufügen', fields: tagFields },
    'action.remove.order.tag': { label: 'Bestellungs-Tags entfernen', fields: tagFields },
    'action.add.customer.tag': { label: 'Kunden-Tags hinzufügen', fields: tagFields },
    'action.remove.customer.tag': { label: 'Kunden-Tags entfernen', fields: tagFields },
    'action.change.customer.group': { label: 'Kundengruppe ändern', fields: [ref('config.customerGroupId', 'Kundengruppe', 'customer_group', { required: true })] },
    'action.change.customer.status': { label: 'Kundenstatus ändern', fields: [bool('config.active', 'Kunde aktiv')] },
    'action.grant.download.access': { label: 'Produktdownloads freigeben', fields: [bool('config.value', 'Downloads freigeben')] },
    'action.add.customer.affiliate.and.campaign.code': { label: 'Kunden-Partner-/Kampagnencode setzen', fields: codeFields },
    'action.add.order.affiliate.and.campaign.code': { label: 'Bestellungs-Partner-/Kampagnencode setzen', fields: codeFields },
    'action.mail.send': { label: 'E-Mail senden', fields: [
        ref('config.mailTemplateId', 'E-Mail-Vorlage', 'mail_template', { required: true, reference: { entity: 'mail_template', labelFields: ['description', 'subject'] } }),
        f('config.recipient.type', 'Empfänger', { type: 'select', required: true, default: 'default', options: [['default', 'Empfänger des Ereignisses'], ['admin', 'Administratoren'], ['custom', 'Eigene Empfänger'], ['contactFormMail', 'Kontaktformular-Absender'], ['revocationRequestCustomerFormMail', 'Widerrufsformular-Absender']] }),
        f('config.recipient.data', 'Eigene Empfänger (E-Mail;Name je Zeile)', { type: 'lines', initialValue: record => Object.entries(record.config?.recipient?.data || {}).map(([email, name]) => `${email};${name}`) }),
        f('config.replyTo', 'Antwortadresse (E-Mail oder contactFormMail)'),
        ref('config.documentTypeIds', 'Vorhandene Dokumente anhängen', 'document_type', { multiple: true }),
    ] },
};

export const flowModule = {
    id: 'flows', title: 'Flow Builder', singular: 'Flow', entity: 'flow', group: 'Automatisierung', icon: 'x-fa fa-sitemap',
    search: ['name', 'eventName'], sort: 'priority', direction: 'DESC', activeFilter: true,
    columns: [{ field: 'name', label: 'Flow' }, { field: 'eventName', label: 'Auslöser' }, { field: 'active', label: 'Aktiv', type: 'boolean', width: 90 }, { field: 'invalid', label: 'Ungültig', type: 'boolean', width: 110 }],
    fields: [f('name', 'Name', { required: true }), f('description', 'Beschreibung', { type: 'textarea' }),
        f('priority', 'Priorität', { type: 'integer', default: 1, required: true }), bool('active', 'Aktiv')],
    editor: async (api, config, definition, id, onSaved) => {
        try {
            const [events, available] = await Promise.all([api.request('/_info/events.json'), api.request('/_info/flow-actions.json')]);
            await openEntityEditor(api, config, { ...definition, fields: [...definition.fields,
                f('eventName', 'Auslöser', { type: 'select', required: true, createOnly: true, options: events.map(event => [event.name, event.name]).sort() }),
                f('eventName', 'Auslöser', { readOnly: true, editOnly: true }),
            ], prepare: async (payload, original) => {
                if (payload.active) {
                    if (!original) throw new Error('Den Flow zuerst inaktiv anlegen und seinen Ablauf ergänzen.');
                    const steps = await api.search('flow-sequence', { limit: 1, filter: [{ type: 'equals', field: 'flowId', value: original.id }] });
                    if (!steps.total) throw new Error('Vor dem Aktivieren mindestens einen Schritt anlegen.');
                }
                return payload;
            }, detailTabs: (api, config, flow) => api.can('flow_sequence:read')
                ? sequences(api, config, flow, available.filter(action => (action.requirements || []).every(requirement => events.find(event => event.name === flow.eventName)?.aware.includes(requirement)))) : [],
            }, id, onSaved);
        } catch (error) { if (api.user) showError(error); }
    },
};

function sequences(api, config, flow, available) {
    const locked = flow.active || !api.can('flow:update');
    const definition = {
        title: 'Ablauf', singular: 'Schritt', entity: 'flow_sequence', create: false, delete: !locked, search: [], sort: 'position', direction: 'ASC',
        filter: [{ type: 'equals', field: 'flowId', value: flow.id }], isLocked: () => locked,
        associations: api.can('rule:read') ? { rule: {} } : {},
        columns: [{ field: 'position', label: 'Reihenfolge', width: 110 }, { field: 'actionName', label: 'Aktion', render: value => value ? actions[value]?.label || value : 'Bedingung' },
            { field: 'rule.name', label: 'Regel' }, { field: 'trueCase', label: 'Wenn erfüllt', type: 'boolean', width: 110 }],
        fields: [], editor: (api, config, definition, id, onSaved) => edit(id, null, onSaved),
        write: async (api, path, method, payload) => {
            const latest = (await api.search('flow', { ids: [flow.id], limit: 1 })).data[0];
            if (!latest || latest.active) throw new Error('Den Flow zuerst deaktivieren und den Editor erneut öffnen.');
            if (method === 'DELETE') {
                const children = await api.search('flow-sequence', { limit: 1, filter: [{ type: 'equals', field: 'parentId', value: path.split('/').at(-1) }] });
                if (children.total) throw new Error('Bitte zuerst die untergeordneten Schritte entfernen.');
            }
            return api.request(path, method, payload);
        },
    };
    const panel = entityListView(api, config, definition); panel.setTitle('Ablauf');
    panel.addDocked({ xtype: 'toolbar', dock: 'top', enableOverflow: true, items: [
        { text: 'Bedingung hinzufügen', disabled: locked || !api.can('flow_sequence:create') || !api.can('rule:read'), handler: () => edit(null, null, () => panel.refreshRecords()) },
        { text: 'Aktion hinzufügen', disabled: locked || !api.can('flow_sequence:create'), handler: chooseAction },
        { xtype: 'tbtext', text: locked ? 'Ablaufbearbeitung: Flow zuerst deaktivieren und erneut öffnen.' : 'Schritte werden einzeln gespeichert. Anschließend den Flow aktivieren.' },
    ] });
    async function edit(id, actionName, onSaved, parentDefaults = {}) {
        try {
            const original = id ? (await api.search('flow-sequence', { ids: [id], limit: 1 })).data[0] : null;
            if (id && !original) throw new Error('Dieser Schritt ist nicht mehr vorhanden.');
            const action = original?.actionName || actionName;
            const actionConfig = action ? await flowActionFields(api, action, original, actions[action]?.fields) : { fields: [] };
            if (!actionConfig) return;
            const fields = [f('position', 'Reihenfolge', { type: 'integer', default: 1, min: 0, required: true }),
                ref('parentId', 'Übergeordneter Schritt (leer = Start)', 'flow_sequence', { reference: { entity: 'flow_sequence', search: ['actionName', 'rule.name'], labelFields: ['rule.name', 'actionName', 'position'], associations: { rule: {} },
                    filter: [{ type: 'equals', field: 'flowId', value: flow.id }] } }),
                bool('trueCase', 'Wenn übergeordnete Bedingung erfüllt ist'),
                ...(action ? actionConfig.fields
                    : [ref('ruleId', 'Regel', 'rule', { required: true })]),
            ];
            const recipientType = original?.config?.recipient?.type;
            if (recipientType && !actions[action]?.fields?.find(field => field.name === 'config.recipient.type')?.options.some(([value]) => value === recipientType)) {
                const recipient = fields.find(field => field.name === 'config.recipient.type');
                if (recipient) { recipient.readOnly = true; recipient.options = [...recipient.options, [recipientType, 'Bestehende spezielle Empfänger']]; }
            }
            await openEntityEditor(api, config, { ...definition, fields, defaults: { flowId: flow.id, actionName: action || null, displayGroup: 1, ...actionConfig.defaults, ...parentDefaults },
                prepare: async (payload, record, { values }) => {
                    if (!record && actionConfig.defaults?.config) payload.config = { ...actionConfig.defaults.config, ...payload.config };
                    payload = prepareFlowAction(action, payload, record, values);
                    const effectiveParent = payload.parentId === undefined ? record?.parentId : payload.parentId;
                    if (effectiveParent && (!record || payload.parentId !== undefined || payload.trueCase !== undefined)) {
                        const seen = new Set(record ? [record.id] : []);
                        let parentId = effectiveParent;
                        while (parentId) {
                            if (seen.has(parentId)) throw new Error('Schritte dürfen nicht unter sich selbst oder ihren Nachfolgern stehen.');
                            seen.add(parentId);
                            const parent = (await api.search('flow-sequence', { ids: [parentId], limit: 1 })).data[0];
                            if (!parent || parent.flowId !== flow.id) throw new Error('Der übergeordnete Schritt muss aus diesem Flow stammen.');
                            if (parentId === effectiveParent) {
                                const siblings = await api.search('flow-sequence', { limit: 1, filter: [
                                    { type: 'equals', field: 'parentId', value: parentId },
                                    ...(record ? [{ type: 'not', operator: 'AND', queries: [{ type: 'equals', field: 'id', value: record.id }] }] : []),
                                    ...(!parent.actionName ? [{ type: 'equals', field: 'trueCase', value: payload.trueCase ?? record?.trueCase ?? false }] : []),
                                ] });
                                if (siblings.total) throw new Error('Dieser Zweig besitzt bereits einen nächsten Schritt. Wähle den letzten Schritt des Zweigs als übergeordneten Schritt.');
                            }
                            parentId = parent.parentId;
                        }
                    }
                    return payload;
                },
            }, id, onSaved);
        } catch (error) { if (api.user) showError(error); }
    }
    function chooseAction(button, event, parentDefaults = {}, onSaved = () => panel.refreshRecords()) {
        const select = Ext.widget(entityField(api, { name: 'action', label: 'Aktion', type: 'select', required: true,
            options: available.map(action => [action.name, actions[action.name]?.label || action.name]) }, null, true));
        const dialog = Ext.create('Ext.window.Window', { title: 'Aktion auswählen', modal: true, bodyPadding: 20, width: Math.min(550, window.innerWidth - 24),
            items: [select], buttons: [{ text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Weiter', cls: 'emz-admin__primary', handler: () => {
                if (!select.isValid()) return;
                const action = select.getValue(); dialog.destroy(); edit(null, action, onSaved, parentDefaults);
            } }],
        });
        dialog.show();
    }
    const tree = Ext.create('Ext.tree.Panel', { title: 'Ablaufbaum', rootVisible: true, useArrows: true,
        store: { fields: ['text', 'stepId', 'parentStepId', 'trueCase', 'action'], root: { text: encode(flow.eventName), expanded: true, children: [] } },
        tbar: [{ text: 'Aktualisieren', handler: loadTree },
            { text: 'Schritt bearbeiten', handler: () => { const id = tree.getSelection()[0]?.get('stepId'); if (id) edit(id, null, refreshBoth); } },
            { text: 'Bedingung anhängen', disabled: locked || !api.can('flow_sequence:create') || !api.can('rule:read'), handler: () => {
                const parent = selectedParent(); if (parent) edit(null, null, refreshBoth, parent);
            } },
            { text: 'Aktion anhängen', disabled: locked || !api.can('flow_sequence:create'), handler: () => {
                const parent = selectedParent(); if (parent) chooseAction(null, null, parent, refreshBoth);
            } }],
        listeners: { activate: loadTree, itemdblclick: (view, row) => { if (row.get('stepId')) edit(row.get('stepId'), null, refreshBoth); } },
    });
    let loadingTree = false;
    function selectedParent() {
        const node = tree.getSelection()[0];
        if (!node || node.isRoot()) return { parentId: null, trueCase: false };
        if (node.get('parentStepId')) return { parentId: node.get('parentStepId'), trueCase: node.get('trueCase') };
        if (node.get('action')) return { parentId: node.get('stepId'), trueCase: false };
        showError(new Error('Bitte den Zweig „Erfüllt“ oder „Nicht erfüllt“ auswählen.')); return null;
    }
    async function refreshBoth() { if (!panel.destroyed) panel.refreshRecords(); await loadTree(); }
    async function loadTree() {
        if (tree.destroyed || loadingTree || !api.user) return;
        loadingTree = true; tree.setLoading('Ablauf wird geladen …');
        try {
            const records = [];
            for (let page = 1; ; page++) {
                const response = await api.search('flow-sequence', { page, limit: 100, filter: definition.filter, associations: definition.associations });
                records.push(...response.data); if (page * 100 >= response.total) break;
            }
            if (!tree.destroyed) tree.setRootNode({ text: encode(flow.eventName), expanded: true, children: buildFlowTree(records,
                step => encode(step.actionName ? actions[step.actionName]?.label || step.actionName : `Bedingung: ${step.rule?.name || step.ruleId}`)) });
        } catch (error) { if (!tree.destroyed && api.user) showError(error); }
        finally { loadingTree = false; if (!tree.destroyed) tree.setLoading(false); }
    }
    return [panel, tree];
}
