import { encode, notify, showError } from '../ui.js';

export const systemToolsModules = [
    { id: 'cache', title: 'Cache & Indizes', entity: 'system_config', group: 'Einstellungen', icon: 'x-fa fa-database',
        access: api => api.can('system:cache:info'), view: cacheView },
    { id: 'logs', title: 'Ereignisprotokoll', singular: 'Protokolleintrag', entity: 'log_entry', group: 'Einstellungen', icon: 'x-fa fa-list',
        create: false, delete: false, search: ['message', 'channel'], sort: 'createdAt', direction: 'DESC',
        columns: [{ field: 'createdAt', label: 'Zeitpunkt', type: 'date', width: 180 }, { field: 'level', label: 'Stufe', width: 100,
            render: value => ({ 100: 'Debug', 200: 'Info', 250: 'Notice', 300: 'Warning', 400: 'Error', 500: 'Critical', 550: 'Alert', 600: 'Emergency' })[value] || value },
        { field: 'channel', label: 'Kanal', width: 160 }, { field: 'message', label: 'Meldung' }],
        fields: [{ name: 'createdAt', label: 'Zeitpunkt', type: 'datetime', readOnly: true }, { name: 'level', label: 'Stufe', type: 'integer', readOnly: true },
            { name: 'channel', label: 'Kanal', readOnly: true }, { name: 'message', label: 'Meldung', type: 'textarea', readOnly: true },
            { name: 'context', label: 'Kontext', type: 'json', readOnly: true }, { name: 'extra', label: 'Weitere Angaben', type: 'json', readOnly: true }],
    },
    { id: 'scheduled-tasks', title: 'Geplante Aufgaben', singular: 'Aufgabe', entity: 'scheduled_task', group: 'Einstellungen', icon: 'x-fa fa-clock',
        create: false, delete: false, search: ['name', 'scheduledTaskClass'], sort: 'name', direction: 'ASC',
        columns: [{ field: 'name', label: 'Aufgabe' }, { field: 'status', label: 'Status', width: 130 }, { field: 'runInterval', label: 'Intervall (s)', width: 110 },
            { field: 'lastExecutionTime', label: 'Zuletzt ausgeführt', type: 'date', width: 180 }, { field: 'nextExecutionTime', label: 'Nächster Lauf', type: 'date', width: 180 }],
        fields: [{ name: 'name', label: 'Aufgabe', readOnly: true }, { name: 'scheduledTaskClass', label: 'Klasse', readOnly: true },
            { name: 'status', label: 'Status', readOnly: true }, { name: 'runInterval', label: 'Intervall in Sekunden', type: 'integer', min: 1, required: true },
            { name: 'lastExecutionTime', label: 'Zuletzt ausgeführt', type: 'datetime', readOnly: true }, { name: 'nextExecutionTime', label: 'Nächster Lauf', type: 'datetime', readOnly: true }],
    },
];

function cacheView(api) {
    let busy = false;
    const status = Ext.create('Ext.Component', { html: '<p>Systeminformationen werden geladen …</p>' });
    const indexers = Ext.create('Ext.form.field.Tag', { name: 'indexers', fieldLabel: 'Indizes auswählen', labelAlign: 'top', anchor: '100%', queryMode: 'local',
        forceSelection: true, displayField: 'name', valueField: 'name', store: { fields: ['name'], data: [] }, listConfig: { getInnerTpl: () => '{name:htmlEncode}' }, labelTpl: '{name:htmlEncode}', collapseOnSelect: true });
    const panel = Ext.create('Ext.panel.Panel', { bodyPadding: 24, scrollable: true, layout: 'anchor', items: [status,
        { xtype: 'fieldset', title: 'Cache', items: [
            { xtype: 'button', text: 'Cache leeren', disabled: !api.can('system:clear:cache'), handler: () => confirm('Cache leeren?', 'Die zwischengespeicherten Inhalte werden neu aufgebaut.', '/_action/cache', 'DELETE') },
            { xtype: 'button', text: 'Ungültige Cache-Einträge entfernen', disabled: !api.can('system:clear:cache'), handler: () => execute('/_action/cache-delayed', 'DELETE') },
            { xtype: 'button', text: 'Alte Cache-Verzeichnisse bereinigen', disabled: !api.can('system:clear:cache'), handler: () => execute('/_action/cleanup', 'DELETE') },
        ] },
        { xtype: 'fieldset', title: 'Indizes', items: [indexers,
            { xtype: 'button', text: 'Ausgewählte Indizes aktualisieren', disabled: !api.can('api_action_cache_index'), handler: () => {
                if (!indexers.getValue().length) { showError(new Error('Bitte mindestens einen Index auswählen.')); return; }
                confirm('Indizes aktualisieren?', 'Die ausgewählten Indizes werden über die Warteschlange neu aufgebaut.', '/_action/index', 'POST', { only: indexers.getValue() });
            } },
        ] },
        { xtype: 'fieldset', title: 'Hintergrundverarbeitung', items: [
            { xtype: 'component', itemId: 'queue', html: '<p>Statistik wird geladen …</p>' },
            { xtype: 'button', text: 'Fällige Aufgaben einplanen', disabled: !api.can('system:queue:process'), handler: () => execute('/_action/scheduled-task/run', 'POST', {}) },
        ] },
    ], tbar: [{ text: 'Aktualisieren', handler: load }], listeners: { afterrender: load } });
    async function load() {
        try {
            const data = await api.request('/_action/cache_info'); if (panel.destroyed) return;
            status.update(`<p>Umgebung: ${encode(data.environment)} · Cache: ${encode(data.cacheAdapter)} · HTTP-Cache: ${data.httpCache ? 'aktiv' : 'inaktiv'}</p>`);
            indexers.getStore().loadData((Array.isArray(data.indexers) ? data.indexers : Object.keys(data.indexers || {})).map(name => ({ name })));
            if (!api.can('message_queue_stats:read')) { panel.down('#queue').update('<p>Keine Leseberechtigung für die Warteschlangenstatistik.</p>'); return; }
            const response = await api.request('/_info/message-stats.json'); if (panel.destroyed) return;
            panel.down('#queue').update(response.enabled ? `<p>Verarbeitete Nachrichten: ${encode(response.stats?.totalMessagesProcessed ?? '—')} · Durchschnittliche Wartezeit: ${encode(response.stats?.averageTimeInQueue ?? '—')} s</p>`
                : '<p>Die Warteschlangenstatistik ist im Shop deaktiviert.</p>');
        } catch (error) { if (!panel.destroyed && api.user) showError(error); }
    }
    function confirm(title, text, path, method, body) { Ext.Msg.confirm(title, text, choice => { if (choice === 'yes') execute(path, method, body); }); }
    async function execute(path, method, body) {
        if (busy || panel.destroyed) return; busy = true; panel.setLoading('Aktion wird ausgeführt …');
        try { await api.request(path, method, body); if (!panel.destroyed) { await load(); notify('Aktion ausgeführt. Hintergrundaufträge werden über die Warteschlange verarbeitet.'); } }
        catch (error) { if (!panel.destroyed && api.user) showError(error); }
        finally { busy = false; if (!panel.destroyed) panel.setLoading(false); }
    }
    return panel;
}
