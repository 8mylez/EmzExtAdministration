import { entityListView } from '../entity-list.js';
import { cmsBlocks } from './cms-catalog.js';
import { blockSlots } from './cms-config.js';
import { editCmsElement } from './cms-element-editor.js';
import { cmsStructure, cmsListView, addPositionControls } from './cms-structure.js';

const f = (name, label, options = {}) => ({ name, label, ...options });
const choose = (name, label, options, extra = {}) => f(name, label, { type: 'select', options, ...extra });
const bool = (name, label, extra = {}) => f(name, label, { type: 'boolean', ...extra });
const media = (name, label) => f(name, label, { type: 'reference', reference: { entity: 'media', labelFields: ['fileName'] } });
const visibility = [bool('visibility.desktop', 'Desktop', { default: true }), bool('visibility.tablet', 'Tablet', { default: true }), bool('visibility.mobile', 'Mobil', { default: true })];
const appearance = [f('backgroundColor', 'Hintergrundfarbe'), media('backgroundMediaId', 'Hintergrundbild'),
    choose('backgroundMediaMode', 'Darstellung des Hintergrundbilds', [['cover', 'Füllend'], ['contain', 'Einpassen'], ['auto', 'Automatisch']], { default: 'cover' }), f('cssClass', 'CSS-Klassen')];

export const cmsModule = {
    id: 'cms', title: 'Erlebniswelten', singular: 'Erlebniswelt', entity: 'cms_page', group: 'Inhalte', icon: 'x-fa fa-columns',
    search: ['name'], sort: 'name', direction: 'ASC', isLocked: record => record?.locked,
    columns: [{ field: 'name', label: 'Name' }, { field: 'type', label: 'Seitentyp', render: value => ({ page: 'Shopseite', landingpage: 'Landingpage', product_list: 'Kategorieseite', product_detail: 'Produktseite' })[value] || value },
        { field: 'locked', label: 'Geschützt', type: 'boolean', width: 120 }],
    fields: [f('name', 'Name', { required: true }), choose('type', 'Seitentyp', [['page', 'Shopseite'], ['landingpage', 'Landingpage'], ['product_list', 'Kategorieseite'], ['product_detail', 'Produktseite']], { required: true, default: 'page', createOnly: true }),
        f('cssClass', 'CSS-Klassen'), f('config.backgroundColor', 'Hintergrundfarbe'), media('previewMediaId', 'Vorschaubild')],
    editorWidth: 1120, view: (api, config) => cmsListView(api, config, cmsModule),
    detailTabs: (api, config, record) => api.can('cms_section:read') ? [
        ...(api.can('cms_block:read') && api.can('cms_slot:read') ? [cmsStructure(api, config, record, sectionDefinition, blockDefinition)] : []), sections(api, config, record),
    ] : [],
};

export function sectionDefinition(page) {
    return {
        title: 'Abschnitte', singular: 'Abschnitt', entity: 'cms_section', search: ['name'], sort: 'position', direction: 'ASC',
        filter: [{ type: 'equals', field: 'pageId', value: page.id }], defaults: { pageId: page.id },
        create: !page.locked, delete: !page.locked, isLocked: record => page.locked || record?.locked,
        columns: [{ field: 'name', label: 'Name' }, { field: 'type', label: 'Typ' }, { field: 'position', label: 'Reihenfolge', width: 110 }],
        fields: [f('name', 'Name'), f('position', 'Reihenfolge', { type: 'integer', min: 0, default: 0, required: true }),
            choose('type', 'Layout', [['default', 'Volle Breite'], ['sidebar', 'Mit Seitenleiste']], { default: 'default', required: true }),
            choose('sizingMode', 'Inhaltsbreite', [['boxed', 'Begrenzt'], ['full_width', 'Gesamte Breite']], { default: 'boxed' }),
            choose('mobileBehavior', 'Seitenleiste auf Mobilgeräten', [['wrap', 'Untereinander'], ['hidden', 'Ausblenden']], { default: 'wrap' }),
            ...appearance, ...visibility],
        detailTabs: (api, config, section) => api.can('cms_block:read') ? [blockList(api, config, section, page)] : [],
    };
}

function sections(api, config, page) {
    const definition = sectionDefinition(page); const panel = entityListView(api, config, definition);
    addPositionControls(api, panel, definition, page.locked); panel.setTitle('Abschnitte'); return panel;
}

export function blockDefinition(section, page) {
    const locked = page.locked || section.locked;
    return {
        title: 'Blöcke', singular: 'Block', entity: 'cms_block', search: ['name'], sort: 'position', direction: 'ASC',
        filter: [{ type: 'equals', field: 'sectionId', value: section.id }], defaults: { sectionId: section.id },
        create: !locked, delete: !locked, isLocked: record => locked || record?.locked,
        columns: [{ field: 'name', label: 'Name' }, { field: 'type', label: 'Inhalt', render: value => cmsBlocks.find(block => block.name === value)?.label || value },
            { field: 'position', label: 'Reihenfolge', width: 110 }],
        fields: [f('name', 'Name'), f('position', 'Reihenfolge', { type: 'integer', min: 0, default: 0, required: true }),
            choose('type', 'Blocktyp', cmsBlocks.filter(block => !block.allowedPageTypes || block.allowedPageTypes.includes(page.type)).map(block => [block.name, block.label]), { createOnly: true, required: true, default: 'text' }),
            choose('sectionPosition', 'Bereich', section.type === 'sidebar' ? [['main', 'Hauptinhalt'], ['sidebar', 'Seitenleiste']] : [['main', 'Hauptinhalt']], { default: 'main', required: true }),
            ...['Top', 'Bottom', 'Left', 'Right'].map((side, i) => f(`margin${side}`, `Abstand ${['oben', 'unten', 'links', 'rechts'][i]}`, { default: '0' })),
            ...appearance, ...visibility],
        prepare: (payload, original) => {
            if (!original) {
                payload.slots = blockSlots(payload.type, page.type);
                for (const [key, value] of Object.entries(cmsBlocks.find(block => block.name === payload.type).defaults)) if (payload[key] === undefined) payload[key] = value;
            }
            return payload;
        },
        detailTabs: (api, config, block) => api.can('cms_slot:read') ? [slots(api, config, block, locked || block.locked)] : [],
    };
}

function blockList(api, config, section, page) {
    const definition = blockDefinition(section, page); const panel = entityListView(api, config, definition);
    addPositionControls(api, panel, definition, page.locked || section.locked); panel.setTitle('Blöcke'); return panel;
}

function slots(api, config, block, locked) {
    const panel = entityListView(api, config, { title: 'Elemente', singular: 'Element', entity: 'cms_slot', create: false, delete: false,
        search: [], sort: 'slot', direction: 'ASC', filter: [{ type: 'equals', field: 'blockId', value: block.id }], fields: [],
        columns: [{ field: 'slot', label: 'Position', render: value => ({ content: 'Inhalt', image: 'Bild', left: 'Links', center: 'Mitte', right: 'Rechts' })[value] || value },
            { field: 'type', label: 'Elementtyp' }],
        editor: (api, config, definition, id, onSaved) => editCmsElement(api, config, id, locked, onSaved),
    });
    panel.setTitle('Elemente'); return panel;
}
