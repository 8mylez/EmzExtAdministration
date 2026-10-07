import { snippetsView } from './snippets.js';
import { openEntityEditor } from '../entity-editor.js';
import { showError } from '../ui.js';
export const textModules = [{
    id: 'snippet-sets', title: 'Textbaustein-Sets', singular: 'Textbaustein-Set', entity: 'snippet_set', group: 'Inhalte', icon: 'x-fa fa-language',
    search: ['name', 'iso'], sort: 'name', direction: 'ASC',
    columns: [{ field: 'name', label: 'Name' }, { field: 'iso', label: 'Sprache', width: 140 }, { field: 'baseFile', label: 'Basisdatei' }],
    detailTabs: (api, config, record) => api.can('snippet:read') ? [snippetsView(api, config, record)] : [],
    editor: async (api, config, definition, id, onSaved) => {
        try {
            const files = (await api.request('/_action/snippet-set/baseFile')).items;
            return openEntityEditor(api, config, { ...definition, fields: definition.fields.map(field => field.name === 'baseFile'
                ? { ...field, type: 'select', options: files.map(file => [file.name, file.name]) }
                : field.name === 'iso' ? { ...field, required: false, readOnly: true } : field),
                prepare: payload => { if (payload.baseFile) payload.iso = files.find(file => file.name === payload.baseFile)?.iso; return payload; },
            }, id, onSaved);
        } catch (error) { if (api.user) showError(error); }
    },
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'iso', label: 'Sprachcode (z. B. de-DE)', required: true },
        { name: 'baseFile', label: 'Basisdatei', required: true }],
}, {
    id: 'snippets', title: 'Textbausteine', singular: 'Textbaustein', entity: 'snippet', group: 'Inhalte', icon: 'x-fa fa-language',
    access: api => api.can('snippet:read') && api.can('snippet_set:read'), view: snippetsView,
    search: ['translationKey', 'value'], sort: 'translationKey', direction: 'ASC', labelFields: ['translationKey'],
    columns: [{ field: 'translationKey', label: 'Schlüssel' }, { field: 'value', label: 'Text' }, { field: 'author', label: 'Autor', width: 140 }],
    fields: [{ name: 'setId', label: 'Textbaustein-Set', required: true, type: 'reference', reference: { entity: 'snippet_set' } },
        { name: 'translationKey', label: 'Schlüssel', required: true }, { name: 'value', label: 'Text', required: true, type: 'textarea', height: 240 },
        { name: 'author', label: 'Autor', required: true, default: '8mylez' }],
}];
