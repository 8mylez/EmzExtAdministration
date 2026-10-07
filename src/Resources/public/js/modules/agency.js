import { entityListView } from '../entity-list.js';
import { openEntityEditor } from '../entity-editor.js';
import { relationPanel } from '../relation-panel.js';
import { cmsBlocks, cmsElements } from './cms-catalog.js';
import { validateLink } from './cms-config.js';

const field = (name, label, options = {}) => ({ name, label, ...options });
const media = (name, label) => field(name, label, { type: 'reference', reference: { entity: 'media', labelFields: ['fileName'] } });
const style = (name, label) => field(name, label, { type: 'select', options: [['primary', 'Primary'], ['secondary', 'Secondary']] });
const buttonFields = [field('buttonText', 'Button-Text'), field('buttonLink', 'Button-Link'), media('buttonMediaId', 'Button-Icon'), style('buttonStyle', 'Button-Stil')];
const prepareLink = payload => { if ('buttonLink' in payload) validateLink(payload.buttonLink); return payload; };

async function writeAgencyRecord(api, path, method, payload) {
    if (method !== 'DELETE') return api.request(path, method, payload);
    const [, entity, id] = path.split('/'); const isTag = entity === 'tag'; const relations = [];
    for (let page = 1; ; page++) {
        const response = await api.request('/search-ids/emz-instruction-tags', 'POST', { page, limit: 100,
            filter: [{ type: 'equals', field: isTag ? 'tagId' : 'instructionId', value: id }],
            sort: [{ field: 'instructionId', order: 'ASC' }, { field: 'tagId', order: 'ASC' }] });
        relations.push(...response.data);
        if (page * 100 >= response.total) break;
    }
    // The installed plugin's mapping has a restrictive tag FK and no instruction FK.
    // Remove only the mappings in the same Sync transaction as the requested record.
    return api.request('/_action/sync', 'POST', {
        ...(relations.length ? { 'instruction-tags': { entity: 'emz_instruction_tags', action: 'delete', payload: relations } } : {}),
        record: { entity: isTag ? 'tag' : 'emz_instruction', action: 'delete', payload: [{ id }] },
    });
}

const team = {
    id: 'team', title: 'Teamverwaltung', singular: 'Teammitglied', entity: 'emz_team_member', group: 'Inhalte',
    search: ['name', 'position'], sort: 'name', direction: 'ASC',
    fields: [field('name', 'Name', { required: true }), field('position', 'Position / Beruf'),
        field('information', 'Information (HTML)', { type: 'textarea', height: 220 }), media('profileImageId', 'Profilbild'), media('backgroundImageId', 'Hintergrundbild')],
    columns: [{ field: 'name', label: 'Name' }, { field: 'position', label: 'Position / Beruf' }],
};

function instructionSteps(api, config, instruction) {
    return entityListView(api, config, {
        title: 'Schritte', singular: 'Schritt', entity: 'emz_instruction_step', search: ['description', 'altStepNumberText'], sort: 'position', direction: 'ASC',
        filter: [{ type: 'equals', field: 'instructionId', value: instruction.id }], defaults: { instructionId: instruction.id, active: true, position: 1, buttonStyle: 'primary' },
        fields: [field('position', 'Position', { type: 'integer', min: 1, required: true }), field('active', 'Aktiv', { type: 'boolean' }),
            field('altStepNumberText', 'Alternativer Schritttitel'), field('description', 'Beschreibung (HTML)', { type: 'textarea', height: 220 }), media('mediaId', 'Bild'), ...buttonFields],
        columns: [{ field: 'position', label: 'Position', width: 100 }, { field: 'altStepNumberText', label: 'Schritttitel' }, { field: 'active', label: 'Aktiv', type: 'boolean', width: 100 }],
        prepare: prepareLink,
        detailTabs: (api, config, record) => api.can('product:read') ? [relationPanel(api, config, { entity: 'emz_instruction_step', id: record.id }, {
            title: 'Produkte', entity: 'product', reverse: 'instructionSteps', mapping: 'emz_instruction_step_product', association: 'products', search: ['name', 'productNumber'],
            columns: [{ field: 'name', label: 'Produkt' }, { field: 'productNumber', label: 'Artikelnummer' }],
        })] : [],
    });
}

const instructions = {
    id: 'instructions', title: 'Bastelanleitungen', singular: 'Bastelanleitung', entity: 'emz_instruction', group: 'Inhalte',
    search: ['headline'], labelFields: ['headline'], sort: 'releaseDate', direction: 'DESC', activeFilter: true, write: writeAgencyRecord,
    defaults: () => ({ active: false, showOptions: 'inactive', releaseDate: new Date().toISOString(), buttonStyle: 'primary', generalButtonStyle: 'primary' }),
    fields: [field('headline', 'Überschrift', { required: true }), field('active', 'Aktiv', { type: 'boolean' }),
        field('showOptions', 'Veröffentlichung', { required: true, type: 'select', options: [['inactive', 'Inaktiv'], ['show', 'Vorschau'], ['publish', 'Online']] }),
        field('releaseDate', 'Veröffentlichungsdatum', { required: true, type: 'datetime' }), field('description', 'Beschreibung (HTML)', { type: 'textarea', height: 220 }),
        field('authorId', 'Autor', { type: 'reference', reference: { entity: 'user', labelFields: ['firstName', 'lastName'], search: ['firstName', 'lastName', 'username'] } }),
        field('workTime', 'Bastelaufwand (Minuten)', { type: 'integer', min: 0 }), field('dryingTime', 'Trocknungszeit'),
        field('level', 'Schwierigkeitsgrad', { type: 'select', options: [['einfach', 'Einfach'], ['mittelschwer', 'Mittelschwer'], ['schwer', 'Schwer']] }),
        media('bannerMediaId', 'Bannerbild'), media('materialMediaId', 'Materialbild'), style('generalButtonStyle', 'Allgemeiner Button-Stil'), ...buttonFields],
    columns: [{ field: 'headline', label: 'Überschrift' }, { field: 'showOptions', label: 'Veröffentlichung', render: value => ({ inactive: 'Inaktiv', show: 'Vorschau', publish: 'Online' })[value] || value },
        { field: 'releaseDate', label: 'Veröffentlichungsdatum', type: 'date', width: 190 }],
    prepare: (payload, original, { api }) => ({ ...prepareLink(payload), ...(Object.keys(payload).length ? { updatedUserId: api.user.id } : {}) }),
    detailTabs: (api, config, record) => [
        ...(api.can('emz_instruction_step:read') ? [instructionSteps(api, config, record)] : []),
        ...(api.can('tag:read') ? [relationPanel(api, config, { entity: 'emz_instruction', id: record.id }, { title: 'Tags', entity: 'tag', reverse: 'emzInstructions', mapping: 'emz_instruction_tags', association: 'tags' })] : []),
    ],
};

function tagEditor(api, config, definition, id, onSaved) {
    const canRead = api.can('emz_tag_seo:read'); const writable = api.can(`emz_tag_seo:${id ? 'update' : 'create'}`) && api.can('emz_tag_seo:create');
    return openEntityEditor(api, config, { ...definition,
        ...(canRead ? { editAssociations: { tagExtension: {} } } : {}),
        fields: [...definition.fields, ...(canRead ? [
            field('extensions.tagExtension.description', 'Tag-Beschreibung (HTML)', { type: 'textarea', height: 220 }),
            field('extensions.tagExtension.metaTitle', 'Tag-Meta-Titel'), field('extensions.tagExtension.metaDescription', 'Tag-Meta-Beschreibung', { type: 'textarea' }),
            field('extensions.tagExtension.keywords', 'Tag-Schlüsselwörter'),
        ].map(item => ({ ...item, readOnly: !writable })) : [])],
        prepare: payload => {
            const extension = payload.extensions?.tagExtension;
            if (extension) payload.extensions = { tagExtension: { tagId: id || payload.id, ...Object.fromEntries(['description', 'metaTitle', 'metaDescription', 'keywords'].filter(key => key in extension).map(key => [key, extension[key]])) } };
            return payload;
        },
    }, id, onSaved);
}

export async function registerAgencyModules(api, modules) {
    const schema = await api.request('/_info/entity-schema.json');
    if (!api.user) return;
    for (const [definition, blockName, elementName, key, label] of [
        [team, 'emz_team_management_block', 'emz_team_management_element', 'teamMembers', 'Team'],
        [instructions, 'emzTinkerInstructionWidgetRowThree', 'emzTinkerInstructionWidget', 'tinkerInstruction', 'Bastelanleitungen'],
    ]) {
        const index = modules.findIndex(module => module.id === definition.id);
        if (!schema[definition.entity]) { if (index >= 0) modules.splice(index, 1); continue; }
        if (index < 0) modules.push(definition);
        if (definition === instructions) definition.isDeleteLocked = () => !api.can('emz_instruction_tags:read') || !api.can('emz_instruction_tags:delete');
        if (!cmsElements.some(item => item.name === elementName)) cmsElements.push({ name: elementName, label, config: { [key]: { source: 'static', value: [], entity: { name: definition.entity } } } });
        if (!cmsBlocks.some(item => item.name === blockName)) cmsBlocks.push({ name: blockName, label, category: 'text', defaults: { marginBottom: '20px', marginTop: '20px', marginLeft: '20px', marginRight: '20px', sizingMode: 'boxed' }, slots: { center: { type: elementName } } });
    }
    const tags = modules.find(module => module.entity === 'tag');
    if (tags) {
        tags.editor = schema.emz_tag_seo ? tagEditor : undefined;
        tags.write = schema.emz_instruction_tags ? writeAgencyRecord : undefined;
        tags.isDeleteLocked = schema.emz_instruction_tags ? () => !api.can('emz_instruction_tags:read') || !api.can('emz_instruction_tags:delete') : undefined;
    }
}
