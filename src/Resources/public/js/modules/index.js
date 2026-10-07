import { documentSettingsModule } from './document-settings.js';
import { profileModule } from './profile.js';
import { featureSetsModule } from './feature-sets.js';
import { measurementModule } from './measurement.js';
import { extensionsModule } from './extensions.js';
import { thumbnailSizesModule } from './media-settings.js';
import { productExportsModule } from './product-exports.js';
import { seoTemplatesModule, seoUrlsModule } from './seo.js';
import { adminSearchView, notificationsModule } from './workspace-tools.js';
import { systemToolsModules } from './system-tools.js';
import { themeModule } from './themes.js';
import { catalogModules, marketingModules } from './catalog.js';
import { settingsModules } from './settings.js';
import { advancedSettingsModules } from './settings-details.js';
import { customerModules } from './customers.js';
import { mediaModule, mediaFoldersModule } from './media.js';
import { orderModule } from './orders.js';
import { systemConfigModules } from './system-config.js';
import { channelModules } from './channels.js';
import { textModules } from './texts.js';
import { ruleModule } from './rules.js';
import { cmsModule } from './cms.js';
import { userModules } from './users.js';
import { flowModule } from './flows.js';
import { customFieldsModule } from './custom-fields.js';
import { importExportModule } from './import-export.js';
import { integrationsModule } from './integrations.js';
import { dashboardView } from '../dashboard.js';
import { productListView } from '../product-list.js';
import { entityListView } from '../entity-list.js';

export const modules = [
    { id: 'global-search', title: 'Globale Suche', entity: 'product', access: api => Boolean(api.user), view: (api, config, navigate) => adminSearchView(api, config, modules, navigate) },
    notificationsModule, extensionsModule, thumbnailSizesModule, productExportsModule, seoTemplatesModule, seoUrlsModule,
    { id: 'dashboard', title: 'Dashboard', entity: 'product', icon: 'emz-admin__icon-dashboard', width: 1080, height: 760,
        access: api => Boolean(api.user), view: dashboardView },
    { id: 'products', title: 'Produkte', entity: 'product', icon: 'emz-admin__icon-products', view: productListView },
    profileModule, featureSetsModule, measurementModule, orderModule, ...catalogModules, ...customerModules, mediaModule, mediaFoldersModule, cmsModule, themeModule, ...textModules,
    ...marketingModules, ...channelModules, ruleModule, flowModule, ...settingsModules, ...advancedSettingsModules, documentSettingsModule, customFieldsModule, integrationsModule, importExportModule, ...systemConfigModules, ...systemToolsModules, ...userModules,
];

export function moduleView(api, config, definition, navigate) {
    return definition.view ? definition.view(api, config, navigate) : entityListView(api, config, definition);
}
