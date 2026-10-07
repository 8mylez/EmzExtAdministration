import { modules, moduleView } from './modules/index.js';
import { encode, showError } from './ui.js';
import { openNativeAdministration } from './sso.js';

export function desktopView(api, config, onLogout) {
    const windows = new Map();
    const workspace = Ext.create('Ext.container.Container', {
        region: 'center', cls: 'emz-admin__desktop',
        html: `<div class="emz-admin__desktop-brand" aria-hidden="true"><img src="${encode(config.logoUrl)}" alt=""><span>6</span></div>`,
    });
    const taskbar = Ext.create('Ext.toolbar.Toolbar', {
        region: 'south', height: 38, cls: 'emz-admin__taskbar', ariaLabel: 'Geöffnete Fenster', enableOverflow: true,
        items: [{ xtype: 'tbtext', text: 'Fenster', cls: 'emz-admin__taskbar-label' }, '->',
            { text: 'Shopware-Administration öffnen', handler: () => openNativeAdministration(api, config.nativeUrl).catch(showError) },
            { xtype: 'tbtext', text: 'Demo zum Spaß · Nicht für den Produktiveinsatz', cls: 'emz-admin__system-label' }],
    });
    const navigation = Ext.create('Ext.toolbar.Toolbar', {
        flex: 1, height: 42, cls: 'emz-admin__header', ariaLabel: 'Hauptmenü', enableOverflow: true,
        items: [
            { xtype: 'tbtext', cls: 'emz-admin__brand', text: '8mylez' }, '-',
            { text: 'Dashboard', itemId: 'dashboard', iconCls: 'emz-admin__icon-dashboard', handler: () => navigate('dashboard') },
            { text: 'Produkte', itemId: 'products', iconCls: 'emz-admin__icon-products',
                disabled: !api.can('product:read'), handler: () => navigate('products') },
            ...[...new Set(modules.map(module => module.group).filter(Boolean))].map(group => ({
                text: group, ariaLabel: group, menu: modules.filter(module => module.group === group).map(module => ({
                    text: module.title, ariaLabel: module.title, disabled: !(module.access ? module.access(api) : api.can(`${module.entity}:read`)), handler: () => navigate(module.id),
                })),
            })),
        ],
    });
    const menu = Ext.create('Ext.container.Container', {
        region: 'north', height: 42, layout: { type: 'hbox', align: 'stretch' }, items: [navigation,
            { xtype: 'toolbar', width: 430, cls: 'emz-admin__header', ariaLabel: 'Benutzer', items: ['->',
                { text: 'Suche', ariaLabel: 'Globale Suche', iconCls: 'x-fa fa-search', handler: () => navigate('global-search') },
                { text: 'Nachrichten', ariaLabel: 'Benachrichtigungen', handler: () => navigate('notifications') },
                { text: encode(api.user.firstName || api.user.username), ariaLabel: 'Mein Profil', handler: () => navigate('profile') },
                { text: 'Abmelden', iconCls: 'emz-admin__icon-logout', handler: button => onLogout(button) },
            ] },
        ],
    });
    const component = Ext.create('Ext.panel.Panel', {
        layout: 'border', border: false, cls: 'emz-admin__shell', items: [menu, workspace, taskbar],
        listeners: { destroy: () => { for (const window of [...windows.values()]) window.destroy(); windows.clear(); } },
    });

    function navigate(page) {
        // Reopen minimized windows even when the URL already points at this module.
        if (window.location.hash === `#${page}`) open(page);
        else window.location.hash = page;
    }

    function open(page) {
        if (component.destroyed || !api.user) return;
        if (!modules.some(module => module.id === page)) page = 'dashboard';
        let window = windows.get(page);
        if (!window) window = createWindow(page);
        window.show();
        window.toFront();
    }

    function createWindow(page) {
        const definition = modules.find(module => module.id === page);
        const { title, icon } = definition;
        const module = (definition.access ? definition.access(api) : api.can(`${definition.entity}:read`))
            ? moduleView(api, config, definition, navigate)
            : Ext.create('Ext.panel.Panel', { bodyPadding: 24, html: `<h1>Keine Berechtigung</h1><p>Dein Benutzer benötigt das Recht „${encode(definition.entity)}:read“.</p>` });
        const width = Math.min(definition.width || 1120, workspace.getWidth() - 32);
        const height = Math.min(definition.height || 720, workspace.getHeight() - 32);
        const window = Ext.create('Ext.window.Window', {
            title, cls: 'emz-admin__module-window', disableCloseToolFocus: false, closeToolText: 'Schließen',
            iconCls: icon || 'x-fa fa-cog',
            renderTo: workspace.getEl(), constrain: true, maximizable: true, minimizable: true,
            closeAction: 'hide', layout: 'fit', width, height, minWidth: Math.min(560, width), minHeight: Math.min(320, height),
            items: [module],
            listeners: {
                afterrender: labelTools,
                maximize: labelTools,
                restore: labelTools,
                activate: () => {
                    if (taskbar.destroyed) return;
                    for (const [key] of windows) taskbar.down(`#task-${key}`)?.toggle(key === page, true);
                },
                minimize: window => window.hide(),
                hide: () => { if (!taskbar.destroyed) taskbar.down(`#task-${page}`)?.toggle(false, true); },
            },
        });
        windows.set(page, window);
        taskbar.insert(taskbar.items.getCount() - 3, {
            text: title, ariaLabel: `Fenster ${title}`, itemId: `task-${page}`, enableToggle: true,
            iconCls: icon || 'x-fa fa-cog',
            handler: () => open(page),
        });
        window.show();
        if (workspace.getWidth() < 800) window.maximize();
        else window.center();
        return window;
    }

    function labelTools(window) {
        const labels = { minimize: 'Minimieren', maximize: 'Maximieren', restore: 'Wiederherstellen', close: 'Schließen' };
        for (const tool of window.getHeader().query('tool')) {
            const label = labels[tool.type];
            if (!label) continue;
            tool.el.dom.setAttribute('aria-label', label);
            tool.el.dom.setAttribute('data-qtip', label);
        }
    }

    // Keep window controls reachable after resizing the browser.
    workspace.on('resize', () => {
        for (const window of windows.values()) {
            if (window.maximized || window.hidden) continue;
            window.minWidth = Math.min(560, workspace.getWidth());
            window.minHeight = Math.min(320, workspace.getHeight());
            window.setSize(Math.min(window.getWidth(), workspace.getWidth()), Math.min(window.getHeight(), workspace.getHeight()));
            window.doConstrain();
        }
    });
    return { component, open };
}
