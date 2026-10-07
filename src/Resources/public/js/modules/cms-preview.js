import { cmsBlocks, cmsElements } from './cms-catalog.js';
import { encode } from '../ui.js';
import { valueAt } from '../entity-data.js';
import { loadCmsRecords } from './cms-config.js';
import { streamQueries } from './stream-data.js';

const allowedTags = new Set(['P', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'BR', 'HR', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'PRE', 'CODE', 'A']);
// CMS HTML stays in a sandbox without scripts; only text formatting is included in this structural preview.
function textHtml(value) {
    const template = document.createElement('template'); template.innerHTML = String(value ?? '');
    function copy(node) {
        if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
        if (node.nodeType !== Node.ELEMENT_NODE || !allowedTags.has(node.tagName)) return document.createTextNode('');
        const result = document.createElement(node.tagName === 'A' ? 'span' : node.tagName.toLowerCase());
        for (const child of node.childNodes) result.append(copy(child)); return result;
    }
    const output = document.createElement('div'); for (const node of template.content.childNodes) output.append(copy(node)); return output.innerHTML;
}
const safeImage = media => media?.url && /^https?:\/\//i.test(media.url)
    ? `<img src="${encode(media.url)}" alt="${encode(media.alt || media.fileName || '')}">` : '<p class="emz-cms__placeholder">Bild auswählen</p>';

export async function cmsPreviewDocument(api, page, sections, blocks, slots, context = {}, viewport = 'desktop') {
    const mediaIds = new Set(); const productIds = new Set();
    for (const slot of slots) for (const [key, item] of Object.entries(slot.config || {})) {
        if (item?.source !== 'static') continue;
        if (['media', 'previewMedia'].includes(key) && typeof item.value === 'string') mediaIds.add(item.value);
        if (key === 'sliderItems' && Array.isArray(item.value)) item.value.forEach(image => mediaIds.add(image.mediaId));
        if (key === 'product' && item.value) productIds.add(item.value);
        if (key === 'products' && Array.isArray(item.value)) item.value.forEach(id => productIds.add(id));
    }
    const media = new Map(); const products = new Map(); const pluginRecords = new Map();
    for (const [type, key, entity, association] of [
        ['emz_team_management_element', 'teamMembers', 'emz_team_member', 'profileMedia'],
        ['emzTinkerInstructionWidget', 'tinkerInstruction', 'emz_instruction', 'bannerMedia'],
    ]) {
        if (!api.can(`${entity}:read`)) continue;
        const ids = [...new Set(slots.filter(slot => slot.type === type).flatMap(slot => slot.config?.[key]?.value || []))];
        for (let offset = 0; offset < ids.length; offset += 100) {
            const response = await api.search(entity.replaceAll('_', '-'), { ids: ids.slice(offset, offset + 100), limit: 100,
                ...(api.can('media:read') ? { associations: { [association]: {} } } : {}) });
            response.data.forEach(record => pluginRecords.set(record.id, record));
        }
    }
    const streams = new Map();
    for (const slot of slots) {
        const item = slot.config?.products;
        if (item?.source !== 'product_stream' || !item.value || !api.can('product_stream_filter:read') || !api.can('product:read')) continue;
        const filters = await loadCmsRecords(api, 'product-stream-filter', [{ type: 'equals', field: 'productStreamId', value: item.value }]);
        const [sortField, direction] = String(slot.config?.productStreamSorting?.value || 'name:ASC').split(':');
        const response = await api.search('product', { limit: Math.min(6, Math.max(1, Number(slot.config?.productStreamLimit?.value) || 6)), filter: streamQueries(filters),
            sort: [{ field: sortField === 'random' ? 'id' : sortField, order: direction === 'DESC' ? 'DESC' : 'ASC' }],
            ...(api.can('media:read') ? { associations: { cover: { associations: { media: {} } } } } : {}) }, { headers: { 'sw-inheritance': '1' } });
        streams.set(slot.id, response.data.map(record => record.id)); response.data.forEach(record => products.set(record.id, record));
    }
    for (const [entity, ids, target] of [['media', [...mediaIds].filter(Boolean), media], ['product', [...productIds], products]]) {
        if (!api.can(`${entity}:read`)) continue;
        for (let index = 0; index < ids.length; index += 100) {
            const response = await api.search(entity, { ids: ids.slice(index, index + 100), limit: 100,
                ...(entity === 'product' && api.can('media:read') ? { associations: { cover: { associations: { media: {} } } } } : {}) }, { headers: { 'sw-inheritance': '1' } });
            response.data.forEach(record => target.set(record.id, record));
        }
    }
    const value = (slot, name) => {
        const item = slot.config?.[name];
        if (item?.source === 'mapped') return valueAt(context, item.value);
        return item?.source === 'static' ? item.value : undefined;
    };
    const productCard = product => product ? `${safeImage(product.cover?.media)}<p><strong>${encode(product.translated?.name || product.name)}</strong></p><p>${encode(product.productNumber)}</p>` : '<p class="emz-cms__placeholder">Produkt aus dem Shop-Kontext</p>';
    const element = slot => {
        const type = slot.type; let content = '';
        if (['text', 'html', 'product-name', 'category-name'].includes(type)) {
            const text = value(slot, 'content');
            content = text === undefined ? `<p class="emz-cms__placeholder">${encode(slot.config?.content?.value || 'Dynamischer Text')}</p>` : textHtml(text);
        } else if (['image', 'manufacturer-logo'].includes(type)) {
            const image = value(slot, 'media'); content = safeImage(typeof image === 'object' ? image : media.get(image));
        } else if (['image-gallery', 'image-slider'].includes(type)) {
            content = `<div class="emz-cms__gallery">${(value(slot, 'sliderItems') || []).slice(0, 6).map(item => safeImage(item.media || media.get(item.mediaId))).join('') || safeImage(null)}</div>`;
        } else if (['buy-box', 'product-box', 'product-description-reviews', 'cross-selling'].includes(type)) {
            const product = value(slot, 'product'); const record = typeof product === 'object' ? product : products.get(product);
            content = type === 'product-description-reviews' ? textHtml(record?.description || 'Produktbeschreibung und Bewertungen') : productCard(record);
        } else if (type === 'product-slider') {
            content = `<h3>${encode(value(slot, 'title'))}</h3><div class="emz-cms__gallery">${(streams.get(slot.id) || (Array.isArray(value(slot, 'products')) ? value(slot, 'products') : [])).slice(0, 6).map(id => `<article>${productCard(products.get(id))}</article>`).join('') || '<p>Keine Produkte für diese Vorschau gefunden.</p>'}</div>`;
        } else if (['emz_team_management_element', 'emzTinkerInstructionWidget'].includes(type)) {
            const key = type === 'emz_team_management_element' ? 'teamMembers' : 'tinkerInstruction';
            content = `<div class="emz-cms__gallery">${(value(slot, key) || []).map(id => {
                const record = pluginRecords.get(id); if (!record) return '';
                return `<article>${safeImage(record.profileMedia || record.bannerMedia)}<h3>${encode(record.name || record.headline)}</h3>${textHtml(record.information || record.description)}</article>`;
            }).join('')}</div>`;
        } else if (type === 'form') content = `<h3>${encode(value(slot, 'title') || 'Formular')}</h3><p class="emz-cms__placeholder">${encode(value(slot, 'type'))}</p>`;
        else content = `<p class="emz-cms__placeholder">${encode(cmsElements.find(item => item.name === type)?.label || type)}</p>`;
        return `<article class="emz-cms__element"><span class="emz-cms__label">${encode(cmsElements.find(item => item.name === type)?.label || type)}</span><div class="emz-cms__content">${content}</div></article>`;
    };
    const visible = record => record.visibility?.[viewport] !== false;
    const blockHtml = block => {
        const catalog = cmsBlocks.find(item => item.name === block.type); const positions = Object.keys(catalog?.slots || {});
        const elements = slots.filter(slot => slot.blockId === block.id).sort((a, b) => positions.indexOf(a.slot) - positions.indexOf(b.slot));
        const columns = block.type.includes('text-') && elements.length === 6 ? 3 : Math.min(elements.length, 4);
        return `<div class="emz-cms__block"><p class="emz-cms__label">${encode(block.name || catalog?.label || block.type)}</p><div class="emz-cms__columns emz-cms__columns-${columns}">${elements.map(element).join('')}</div></div>`;
    };
    const body = sections.filter(visible).sort((a, b) => a.position - b.position).map(section => {
        const children = blocks.filter(block => block.sectionId === section.id && visible(block)).sort((a, b) => a.position - b.position);
        const main = children.filter(block => block.sectionPosition !== 'sidebar').map(blockHtml).join('');
        const sidebar = children.filter(block => block.sectionPosition === 'sidebar').map(blockHtml).join('');
        const showSidebar = section.type === 'sidebar' && !(viewport === 'mobile' && section.mobileBehavior === 'hidden');
        return `<section class="emz-cms__section"><h2 class="emz-cms__label">${encode(section.name || 'Abschnitt')}</h2><div class="${showSidebar ? 'emz-cms__sidebar-layout' : ''}">${showSidebar ? `<aside>${sidebar}</aside>` : ''}<main>${main}</main></div></section>`;
    }).join('');
    const stylesheet = new URL('../../css/cms-preview.css', import.meta.url).href;
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http:; style-src ${encode(location.origin)}; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${encode(page.name)}</title><link rel="stylesheet" href="${encode(stylesheet)}"></head><body>${body || '<p>Noch keine Abschnitte vorhanden.</p>'}</body></html>`;
}
