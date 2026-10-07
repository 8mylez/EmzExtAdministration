import { entityListView } from '../entity-list.js';
import { entityField, errorHtml } from '../entity-fields.js';
import { encode, notify } from '../ui.js';
import { exportPresets } from './export-presets.js';

const field = (name, label, extra = {}) => ({ name, label, ...extra });
const ref = (name, label, entity, extra = {}) => field(name, label, { type: 'reference', required: true, reference: { entity }, ...extra });

function exportDefinition(config, channel) {
    return { ...productExportsModule, singular: 'Produktfeed', search: ['fileName'], sort: 'fileName', direction: 'ASC',
        ...(channel ? { filter: [{ type: 'equals', field: 'salesChannelId', value: channel.id }], defaults: { salesChannelId: channel.id } } : {}),
        columns: [{ field: 'fileName', label: 'Dateiname' }, { field: 'fileFormat', label: 'Format', width: 100 }, { field: 'generateByCronjob', label: 'Automatisch', type: 'boolean', width: 120 }, { field: 'generatedAt', label: 'Zuletzt erzeugt', type: 'date', width: 170 }],
        fields: [
            ...(!channel ? [ref('salesChannelId', 'Export-Verkaufskanal', 'sales_channel', { reference: { entity: 'sales_channel', filter: [{ type: 'equals', field: 'typeId', value: config.productExportTypeId }] } })] : []),
            ref('salesChannelDomainId', 'Storefront-Domain', 'sales_channel_domain', { reference: { entity: 'sales_channel_domain', labelFields: ['url'] } }),
            ref('productStreamId', 'Dynamische Produktgruppe', 'product_stream'), ref('currencyId', 'Währung', 'currency', { default: config.currencyId }),
            field('fileName', 'Dateiname', { required: true, default: 'produkte.csv' }),
            field('fileFormat', 'Dateiformat', { type: 'select', required: true, default: 'csv', options: [['csv', 'CSV'], ['xml', 'XML'], ['jsonl', 'JSON Lines']] }),
            field('encoding', 'Zeichenkodierung', { type: 'select', required: true, default: 'UTF-8', options: [['UTF-8', 'UTF-8'], ['ISO-8859-1', 'ISO-8859-1']] }),
            field('includeVariants', 'Varianten einbeziehen', { type: 'boolean' }), field('generateByCronjob', 'Automatisch erzeugen', { type: 'boolean' }),
            field('interval', 'Erzeugungsintervall (Sekunden, 0 = bei Abruf)', { type: 'integer', min: 0, required: true, default: 0 }),
            field('pausedSchedule', 'Automatische Erzeugung pausieren', { type: 'boolean' }), field('feedLabel', 'Feed-Label'),
        ],
        prepare: async (payload, original, { api }) => {
            const values = { ...original, ...payload };
            if (!/^[\w.-]+\.(csv|xml|jsonl)$/i.test(values.fileName) || values.fileName.startsWith('.')) throw new Error('Bitte einen Dateinamen ohne Verzeichnisse und mit Endung csv, xml oder jsonl eingeben.');
            if (values.feedLabel && !/^[A-Z0-9_-]{1,20}$/.test(values.feedLabel)) throw new Error('Das Feed-Label darf höchstens 20 Großbuchstaben, Ziffern, Unterstriche oder Bindestriche enthalten.');
            const domain = (await api.search('sales-channel-domain', { ids: [values.salesChannelDomainId], limit: 1 })).data[0];
            if (!domain) throw new Error('Die Storefront-Domain ist nicht mehr vorhanden.');
            payload.storefrontSalesChannelId = domain.salesChannelId;
            if (!original) {
                payload.accessKey = (await api.request('/_action/access-key/product-export')).accessKey;
                payload.headerTemplate = 'Artikelnummer;Name'; payload.bodyTemplate = '{{ product.productNumber }};{{ product.translated.name|replace({";": ",", "\\n": " ", "\\r": " "}) }}'; payload.footerTemplate = '';
            }
            return payload;
        },
        detailTabs: (api, config, record) => [templatePanel(api, record)],
    };
}

export function channelProductExports(api, config, channel) {
    const panel = entityListView(api, config, exportDefinition(config, channel)); panel.setTitle('Produktfeeds'); return panel;
}
export const productExportsModule = { id: 'product-exports', title: 'Produktfeeds', entity: 'product_export', group: 'Verkaufskanäle',
    view: (api, config) => entityListView(api, config, exportDefinition(config)),
};

function templatePanel(api, record) {
    const writable = api.can('product_export:update'); let saving = false; let original = record; let previewContent = '';
    const fields = ['headerTemplate', 'bodyTemplate', 'footerTemplate'].map((name, index) => field(name, ['Kopfzeile (Twig)', 'Produktzeile (Twig)', 'Fußzeile (Twig)'][index], { type: 'textarea', height: index === 1 ? 300 : 130 }));
    const preset = Ext.create('Ext.form.field.ComboBox', { fieldLabel: 'Standardvorlage', labelAlign: 'top', queryMode: 'local', editable: false, readOnly: !writable,
        store: exportPresets.map(preset => [preset.name, preset.label]), anchor: '100%' });
    const form = Ext.create('Ext.form.Panel', { bodyPadding: 20, scrollable: true, items: [preset,
        { xtype: 'button', text: 'Vorlage übernehmen', disabled: !writable, handler: () => {
            const selected = exportPresets.find(item => item.name === preset.getValue()); if (!selected) return;
            Ext.Msg.confirm('Vorlage übernehmen?', 'Die drei Vorlagentexte werden ersetzt. Dateiformat, Kodierung und Dateiname werden beim Speichern ebenfalls aus der Vorlage übernommen.', choice => {
                if (choice !== 'yes' || form.destroyed) return;
                form.getForm().setValues(selected); form.selectedPreset = selected;
            });
        } }, ...fields.map(descriptor => entityField(api, descriptor, record[descriptor.name], writable)),
        { xtype: 'component', itemId: 'error', cls: 'emz-admin__error', ariaRole: 'alert' },
        { xtype: 'textareafield', name: 'preview', fieldLabel: 'Vorschau', labelAlign: 'top', anchor: '100%', height: 240, readOnly: true },
    ] });
    const panel = Ext.create('Ext.panel.Panel', { title: 'Vorlagen & Vorschau', layout: 'fit', items: [form], bbar: [
        { text: 'Vorlagen prüfen', disabled: !writable, handler: () => run('validate') }, { text: 'Vorschau erzeugen', disabled: !writable, handler: () => run('preview') },
        { text: 'Vorlagen speichern', disabled: !writable, handler: () => run('save') }, { text: 'Vorschau herunterladen', handler: () => {
            if (!previewContent) return;
            const url = URL.createObjectURL(new Blob([previewContent], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a');
            link.href = url; link.download = `vorschau-${original.fileName}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        } }, { text: 'Feed-Link anzeigen', handler: showLink },
    ] });
    form.getForm().getFields().each(field => field.resetOriginalValue());
    panel.hasUnsavedChanges = () => Boolean(saving || form.selectedPreset || fields.some(field => form.getForm().findField(field.name).isDirty()));
    async function payload() {
        const current = (await api.search('product-export', { ids: [record.id], limit: 1 })).data[0];
        if (!current) throw new Error('Dieser Produktfeed ist nicht mehr vorhanden.');
        const values = Object.fromEntries(fields.map(field => [field.name, form.getForm().findField(field.name).getValue()]));
        if (form.selectedPreset) for (const key of ['fileName', 'fileFormat', 'encoding']) values[key] = form.selectedPreset[key];
        return { current, values, data: { ...current, ...values } };
    }
    async function run(action) {
        if (saving || !writable) return; saving = true; panel.setLoading('Produktfeed wird geprüft …'); form.down('#error').update('');
        try {
            const { current, values, data } = await payload();
            const result = await api.request(`/_action/product-export/${action === 'preview' ? 'preview' : 'validate'}`, 'POST', data);
            if (panel.destroyed) return;
            if (result?.errors?.length) throw new Error(result.errors.join('\n'));
            if (action === 'save') {
                for (const field of fields) if (current[field.name] !== original[field.name]) throw new Error('Die Vorlagen wurden inzwischen geändert. Bitte den Produktfeed erneut öffnen.');
                await api.request(`/product-export/${record.id}`, 'PATCH', values); original = { ...current, ...values }; form.selectedPreset = null;
                form.getForm().getFields().each(field => field.resetOriginalValue()); notify('Vorlagen gespeichert.');
            } else if (action === 'preview') { previewContent = result?.content || ''; form.getForm().findField('preview').setValue(previewContent); }
            else notify('Vorlagen erfolgreich geprüft.');
        } catch (error) { if (!panel.destroyed && api.user) form.down('#error').update(errorHtml(error)); }
        finally { saving = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    async function showLink() {
        try {
            const result = await api.search('product-export', { ids: [record.id], limit: 1, associations: { salesChannelDomain: {} } }); const feed = result.data[0];
            const domain = feed?.salesChannelDomain?.url;
            if (!domain || !/^https?:\/\//i.test(domain)) throw new Error('Dem Produktfeed fehlt eine gültige Storefront-Domain.');
            const link = `${domain.replace(/\/+$/, '')}/store-api/product-export/${encodeURIComponent(feed.accessKey)}/${encodeURIComponent(feed.fileName)}`;
            Ext.create('Ext.window.Window', { title: 'Produktfeed abrufen', width: Math.min(700, innerWidth - 24), modal: true, constrain: true, bodyPadding: 20, items: [
                { xtype: 'textfield', fieldLabel: 'Feed-Link', labelAlign: 'top', anchor: '100%', readOnly: true, value: link },
                { xtype: 'component', html: `<p>Der Export-Verkaufskanal muss aktiv sein. Der Link erlaubt den Abruf dieses Feeds.</p><a href="${encode(link)}" target="_blank" rel="noopener noreferrer">Produktfeed öffnen</a>` },
            ] }).show();
        } catch (error) { if (!panel.destroyed) form.down('#error').update(errorHtml(error)); }
    }
    return panel;
}
