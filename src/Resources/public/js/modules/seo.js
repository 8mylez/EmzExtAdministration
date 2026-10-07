import { entityListView } from '../entity-list.js';
import { entityField } from '../entity-fields.js';
import { uuid } from '../entity-data.js';
import { encode, notify, showError } from '../ui.js';

const routes = {
    product: { routeName: 'frontend.detail.page', headlessRoute: 'store-api.product.detail', path: '/detail/' },
    category: { routeName: 'frontend.navigation.page', headlessRoute: 'store-api.category.detail', path: '/navigation/' },
    landing_page: { routeName: 'frontend.landing.page', headlessRoute: 'store-api.landing-page.detail', path: '/landingPage/' },
};
const routeLabel = route => ({ 'frontend.detail.page': 'Produkte · Storefront', 'frontend.navigation.page': 'Kategorien · Storefront', 'frontend.landing.page': 'Landingpages · Storefront',
    'store-api.product.detail': 'Produkte · Headless', 'store-api.category.detail': 'Kategorien · Headless', 'store-api.landing-page.detail': 'Landingpages · Headless' })[route] || route;

async function externalDomain(api, channelId, languageId) {
    const response = await api.search('sales-channel-domain', { limit: 1, filter: [
        { type: 'equals', field: 'salesChannelId', value: channelId }, { type: 'equals', field: 'languageId', value: languageId }, { type: 'equals', field: 'isExternalStorefront', value: true },
    ] });
    if (!response.data[0]) throw new Error('Bitte zuerst eine Domain als externes Frontend für diesen Headless-Verkaufskanal und diese Sprache hinterlegen.');
    return response.data[0].url.replace(/\/+$/, '') + '/';
}

export const seoTemplatesModule = { id: 'seo-templates', title: 'SEO-URL-Vorlagen', singular: 'Kanalvorlage', entity: 'seo_url_template', group: 'Einstellungen',
    search: ['routeName', 'template'], sort: 'routeName', direction: 'ASC', delete: false, fields: [], labelFields: ['routeName'],
    columns: [{ field: 'routeName', label: 'Seitentyp', render: routeLabel }, { field: 'salesChannelId', label: 'Geltungsbereich', render: value => value || 'Alle Verkaufskanäle' }, { field: 'template', label: 'Vorlage', render: value => value === null ? 'Globale Vorgabe' : value }],
    editor: editTemplate,
};

async function editTemplate(api, config, definition, id, onSaved) {
    let record; let defaults;
    try {
        [record, defaults] = await Promise.all([id ? api.search('seo-url-template', { ids: [id], limit: 1 }).then(response => response.data[0]) : null,
            api.search('seo-url-template', { limit: 100, filter: [{ type: 'equals', field: 'salesChannelId', value: null }] }).then(response => response.data)]);
        if (id && !record) throw new Error('Die Vorlage ist nicht mehr vorhanden.');
    } catch (error) { if (api.user) showError(error); return; }
    if (record && !defaults.some(item => item.routeName === record.routeName)) defaults.push(record);
    const writable = api.can(`seo_url_template:${id ? 'update' : 'create'}`) && api.can('seo_url_template:update'); let busy = false;
    const route = Ext.widget(entityField(api, { name: 'routeName', label: 'Seitentyp', type: 'select', required: true, options: defaults.map(item => [item.routeName, routeLabel(item.routeName)]) }, record?.routeName, writable && !id));
    const channel = entityField(api, { name: 'salesChannelId', label: record && !record.salesChannelId ? 'Geltungsbereich: alle Verkaufskanäle' : 'Verkaufskanal', required: !id, type: 'reference', reference: { entity: 'sales_channel' } }, record?.salesChannelId, writable && !id);
    const inherit = Ext.create('Ext.form.field.Checkbox', { name: 'inherit', boxLabel: 'Globale Vorlage verwenden', hidden: Boolean(id && !record.salesChannelId), checked: Boolean(record?.salesChannelId && record.template === null), disabled: !writable });
    const template = Ext.widget(entityField(api, { name: 'template', label: 'URL-Vorlage (Twig)', type: 'textarea', height: 150, maxLength: 750, required: true }, record?.template, writable));
    inherit.on('change', (field, checked) => template.setDisabled(checked)); template.setDisabled(inherit.getValue());
    const store = Ext.create('Ext.data.Store', { fields: ['foreignKey', 'seoPathInfo', 'error'] });
    const form = Ext.create('Ext.form.Panel', { region: 'north', height: 380, bodyPadding: 20, scrollable: true, items: [route, channel, inherit, template] });
    const grid = Ext.create('Ext.grid.Panel', { region: 'center', store, columns: [{ text: 'Vorschau', dataIndex: 'seoPathInfo', flex: 2, renderer: encode }, { text: 'Hinweis', dataIndex: 'error', flex: 1, renderer: encode }] });
    const dialog = Ext.create('Ext.window.Window', { title: id ? 'SEO-Vorlage bearbeiten' : 'SEO-Kanalvorlage anlegen', modal: true, constrain: true, layout: 'border', width: Math.min(850, innerWidth - 24), height: Math.min(850, innerHeight - 32), items: [form, grid],
        dockedItems: [{ xtype: 'component', dock: 'bottom', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' }], buttons: [
            { text: 'Abbrechen', handler: () => dialog.close() }, { text: 'Vorschau prüfen', disabled: !api.can('seo_url_template:update'), handler: () => run(false) },
            { text: 'Speichern', cls: 'emz-admin__primary', disabled: !writable, handler: () => run(true) },
        ], listeners: { destroy: () => store.destroy(), beforeclose: () => {
            if (busy) return false; if (!form.getForm().isDirty()) return true;
            Ext.Msg.confirm('Änderungen verwerfen?', 'Ungespeicherte Vorlagenänderungen gehen verloren.', answer => { if (answer === 'yes') dialog.destroy(); }); return false;
        } },
    }); dialog.show(); form.getForm().getFields().each(field => field.resetOriginalValue());
    async function run(save) {
        if (busy || !form.getForm().isValid()) return;
        const source = defaults.find(item => item.routeName === route.getValue()) || record;
        if (!source) return;
        const payload = { routeName: route.getValue(), salesChannelId: channel.getValue() || null, entityName: source.entityName, isHeadless: source.isHeadless, template: inherit.getValue() ? null : template.getValue().trim() };
        busy = true; dialog.setLoading(save ? 'Vorlage wird geprüft und gespeichert …' : 'Vorschau wird erstellt …'); dialog.down('#error').update('');
        try {
            if (payload.salesChannelId) {
                const selected = (await api.search('sales-channel', { ids: [payload.salesChannelId], limit: 1 })).data[0];
                if (!selected || ![config.headlessTypeId, config.storefrontTypeId].includes(selected.typeId)) throw new Error('SEO-Vorlagen benötigen einen Storefront- oder Headless-Verkaufskanal.');
                if (Boolean(source.isHeadless) !== (selected.typeId === config.headlessTypeId)) throw new Error('Der Seitentyp muss zum Verkaufskanal passen: Storefront beziehungsweise Headless.');
                if (selected.typeId === config.headlessTypeId) await externalDomain(api, selected.id, config.languageId);
            }
            const preview = await api.request('/_action/seo-url-template/preview', 'POST', { ...payload, template: payload.template ?? source.template, criteria: { limit: 10 } });
            store.loadData(preview || []);
            if (preview?.some(item => item.error)) throw new Error(preview.filter(item => item.error).map(item => item.error).join('\n'));
            if (!save) { if (!preview?.length) dialog.down('#error').update('Keine passenden Datensätze für die Vorschau vorhanden.'); return; }
            if (record) {
                const current = (await api.search('seo-url-template', { ids: [id], limit: 1 })).data[0];
                if (!current || current.template !== record.template) throw new Error('Diese Vorlage wurde zwischenzeitlich geändert. Bitte neu laden.');
            } else {
                const existing = await api.search('seo-url-template', { limit: 1, filter: [{ type: 'equals', field: 'routeName', value: payload.routeName }, { type: 'equals', field: 'salesChannelId', value: payload.salesChannelId }] });
                if (existing.total) throw new Error('Für diesen Verkaufskanal und Seitentyp gibt es bereits eine Vorlage. Bitte diese bearbeiten.');
            }
            await api.request(id ? `/seo-url-template/${id}` : '/seo-url-template', id ? 'PATCH' : 'POST', id ? { template: payload.template } : { id: uuid(), ...payload });
            dialog.destroy(); notify('SEO-Vorlage gespeichert. Shopware aktualisiert die URLs über die Warteschlange.'); onSaved();
        } catch (error) { if (!dialog.destroyed && api.user) dialog.down('#error').update(encode(error.message)); }
        finally { busy = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}

export const seoUrlsModule = { id: 'seo-urls', title: 'SEO-URLs', singular: 'SEO-URL', entity: 'seo_url', group: 'Einstellungen', create: false, delete: false,
    search: ['seoPathInfo', 'pathInfo'], sort: 'createdAt', direction: 'DESC', fields: [], labelFields: ['seoPathInfo'],
    columns: [{ field: 'seoPathInfo', label: 'SEO-Pfad' }, { field: 'routeName', label: 'Seitentyp', render: routeLabel }, { field: 'isCanonical', label: 'Haupt-URL', type: 'boolean', width: 110 }, { field: 'isModified', label: 'Individuell', type: 'boolean', width: 110 }, { field: 'isDeleted', label: 'Gelöscht', type: 'boolean', width: 90 }],
    editor: async (api, config, definition, id, onSaved) => {
        try { const record = (await api.search('seo-url', { ids: [id], limit: 1 })).data[0]; if (record) editSeoUrl(api, config, record, null, onSaved); }
        catch (error) { if (api.user) showError(error); }
    },
};

export function seoUrlsPanel(api, config, owner) {
    const panel = entityListView(api, config, { ...seoUrlsModule, filter: [{ type: 'equals', field: 'foreignKey', value: owner.id }] }); panel.setTitle('SEO-URLs');
    panel.addDocked({ xtype: 'toolbar', dock: 'top', items: [{ text: 'SEO-URL festlegen', disabled: !api.can('seo_url:update'), handler: () => editSeoUrl(api, config, null, owner, () => panel.refreshRecords()) }] });
    return panel;
}

function editSeoUrl(api, config, record, owner, onSaved) {
    const route = owner ? routes[owner.entity] : { routeName: record.routeName };
    const entity = owner?.entity || Object.keys(routes).find(entity => [routes[entity].routeName, routes[entity].headlessRoute].includes(record.routeName));
    const writable = api.can('seo_url:update'); let busy = false;
    const fields = [
        { name: 'salesChannelId', label: 'Verkaufskanal', type: 'reference', required: true, reference: { entity: 'sales_channel' } },
        { name: 'languageId', label: 'Sprache', type: 'reference', required: true, default: config.languageId, reference: { entity: 'language' } },
        { name: 'seoPathInfo', label: 'SEO-Pfad', required: true, maxLength: 750 },
    ];
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, items: [
        { xtype: 'component', html: '<p>Diese Adresse wird zur Haupt-URL. Vorherige Adressen bleiben für Weiterleitungen erhalten.</p>' },
        ...fields.map(field => entityField(api, field, record?.[field.name], writable)), { xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
    ] });
    const dialog = Ext.create('Ext.window.Window', { title: 'SEO-URL festlegen', modal: true, constrain: true, layout: 'fit', width: Math.min(640, innerWidth - 24), items: [form], buttons: [
        { text: 'Abbrechen', handler: () => dialog.close() },
        { text: 'Vorlagen-URL wiederherstellen', disabled: !writable || !entity || !api.can('seo_url_template:read') || !api.can('seo_url_template:update'), handler: () => save(true) },
        { text: 'Haupt-URL speichern', cls: 'emz-admin__primary', disabled: !writable, handler: () => save(false) },
    ], listeners: { beforeclose: () => !busy } }); dialog.show();
    async function save(reset) {
        if (busy || !writable || (!reset && !form.getForm().isValid())) return;
        const values = form.getForm().getFieldValues(); if (!values.salesChannelId || !values.languageId) return;
        busy = true; dialog.setLoading('SEO-URL wird gespeichert …');
        const headers = { 'sw-language-id': values.languageId }; const foreignKey = owner?.id || record.foreignKey;
        try {
            const selected = (await api.search('sales-channel', { ids: [values.salesChannelId], limit: 1 })).data[0];
            if (!selected || ![config.headlessTypeId, config.storefrontTypeId].includes(selected.typeId)) throw new Error('Bitte einen Storefront- oder Headless-Verkaufskanal auswählen.');
            const routeName = entity ? routes[entity][selected.typeId === config.headlessTypeId ? 'headlessRoute' : 'routeName'] : route.routeName;
            const domain = selected.typeId === config.headlessTypeId ? await externalDomain(api, selected.id, values.languageId) : null;
            let payload = { routeName: route.routeName, foreignKey, pathInfo: record?.pathInfo || `${route.path}${foreignKey}`, salesChannelId: values.salesChannelId,
                seoPathInfo: values.seoPathInfo.trim().replace(/^\/+/, ''), isCanonical: true, isModified: true, isDeleted: false };
            if (reset) {
                const templates = (await api.search('seo-url-template', { limit: 100, filter: [{ type: 'equals', field: 'routeName', value: routeName }, { type: 'multi', operator: 'OR', queries: [
                    { type: 'equals', field: 'salesChannelId', value: null }, { type: 'equals', field: 'salesChannelId', value: values.salesChannelId },
                ] }] })).data;
                const template = templates.find(item => item.salesChannelId === values.salesChannelId)?.template ?? templates.find(item => !item.salesChannelId)?.template;
                if (!template) throw new Error('Keine aktive Vorlage für diesen Verkaufskanal vorhanden.');
                const preview = await api.request('/_action/seo-url-template/preview', 'POST', { template, salesChannelId: values.salesChannelId, routeName, entityName: entity, criteria: { ids: [foreignKey], limit: 1 } }, { headers });
                const generated = preview?.find(item => item.foreignKey === foreignKey);
                if (!generated || generated.error) throw new Error(generated?.error || 'Keine URL erzeugt. Bitte Aktivierung und Verkaufskanal-Zuordnung prüfen.');
                payload = { ...payload, routeName, pathInfo: generated.pathInfo, seoPathInfo: generated.seoPathInfo, isModified: false };
            }
            // Headless preview includes the external domain; Shopware stores only the relative SEO path.
            if (domain && payload.seoPathInfo.startsWith(domain)) payload.seoPathInfo = payload.seoPathInfo.slice(domain.length);
            const used = await api.search('seo-url', { limit: 1, filter: [{ type: 'equals', field: 'salesChannelId', value: values.salesChannelId }, { type: 'equals', field: 'languageId', value: values.languageId },
                { type: 'equals', field: 'seoPathInfo', value: payload.seoPathInfo }, { type: 'not', operator: 'AND', queries: [{ type: 'equals', field: 'foreignKey', value: foreignKey }] }] });
            if (used.total) throw new Error('Dieser SEO-Pfad gehört bereits zu einem anderen Datensatz.');
            await api.request('/_action/seo-url/canonical', 'PATCH', payload, { headers }); dialog.destroy(); notify('Haupt-URL gespeichert.'); onSaved();
        } catch (error) { if (!dialog.destroyed && api.user) form.down('#error').update(encode(error.message)); }
        finally { busy = false; if (!dialog.destroyed) dialog.setLoading(false); }
    }
}
