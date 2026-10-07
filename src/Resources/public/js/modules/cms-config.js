import { cmsBlocks, cmsElements } from './cms-catalog.js';
import { uuid } from '../entity-data.js';

export function elementConfig(type) {
    return Object.fromEntries(Object.entries(cmsElements.find(item => item.name === type)?.config || {})
        .map(([key, value]) => [key, { source: value.source, value: structuredClone(value.value) }]));
}

export function blockSlots(type, pageType) {
    const block = cmsBlocks.find(item => item.name === type);
    if (!block) throw new Error('Dieser Blocktyp ist nicht verfügbar.');
    if (block.allowedPageTypes && !block.allowedPageTypes.includes(pageType)) throw new Error('Dieser Block ist für den gewählten Seitentyp nicht geeignet.');
    return Object.entries(block.slots).map(([slot, definition]) => ({ id: uuid(), slot, type: definition.type,
        config: { ...elementConfig(definition.type), ...structuredClone(definition.config || {}) } }));
}

const labels = {
    content: 'Text (HTML)', media: 'Bild / Video', product: 'Produkt', products: 'Produkte', sliderItems: 'Bilder', teamMembers: 'Teammitglieder', tinkerInstruction: 'Bastelanleitungen',
    title: 'Titel', confirmationText: 'Bestätigungstext', verticalAlign: 'Vertikale Ausrichtung', horizontalAlign: 'Horizontale Ausrichtung', alignment: 'Ausrichtung',
    displayMode: 'Darstellung', minHeight: 'Mindesthöhe', ariaLabel: 'Barrierefreie Beschriftung', url: 'Link', newTab: 'In neuem Tab öffnen',
    fetchPriorityHigh: 'Hohe Ladepriorität', isDecorative: 'Dekoratives Bild', boxLayout: 'Produktdarstellung', boxHeadlineLevel: 'Überschriftenebene',
    showSorting: 'Sortierung anzeigen', useCustomSorting: 'Eigene Sortierungen', availableSortings: 'Verfügbare Sortierungen', defaultSorting: 'Standardsortierung',
    filters: 'Filter', propertyWhitelist: 'Filterbare Eigenschaftsgruppen', navigationArrows: 'Navigationspfeile', navigationDots: 'Navigationspunkte',
    galleryPosition: 'Position der Vorschaubilder', zoom: 'Zoom', fullScreen: 'Vollbild', keepAspectRatioOnZoom: 'Seitenverhältnis beim Zoom erhalten',
    magnifierOverGallery: 'Lupe über der Galerie', useFetchPriorityOnFirstItem: 'Erstes Bild mit hoher Ladepriorität', speed: 'Animationsdauer (ms)',
    autoSlide: 'Automatisch wechseln', autoplayTimeout: 'Zeit zwischen Folien (ms)', rotate: 'Automatisch wechseln', border: 'Rahmen', elMinWidth: 'Mindestbreite pro Element',
    productStreamSorting: 'Sortierung der Produktgruppe', productStreamLimit: 'Maximale Produktanzahl', type: 'Formulartyp', mailReceiver: 'Empfänger (eine E-Mail je Zeile)',
    defaultMailReceiver: 'Standardempfänger verwenden', videoID: 'Video-ID', iframeTitle: 'Barrierefreier Videotitel', autoPlay: 'Automatisch abspielen', autoplay: 'Automatisch abspielen',
    muted: 'Stumm', loop: 'Wiederholen', playsInline: 'Video innerhalb der Seite abspielen', showControls: 'Steuerelemente anzeigen', showCover: 'Vorschaubild anzeigen',
    start: 'Startzeit (Sekunden)', end: 'Endzeit (Sekunden)', advancedPrivacyMode: 'Erweiterter Datenschutzmodus', needsConfirmation: 'Einwilligung erforderlich',
    previewMedia: 'Vorschaubild', byLine: 'Autor anzeigen', color: 'Farbe', doNotTrack: 'Tracking deaktivieren', portrait: 'Autorenbild anzeigen', controls: 'Steuerelemente anzeigen',
};
const choices = {
    verticalAlign: [['top', 'Oben'], ['center', 'Mitte'], ['bottom', 'Unten']], horizontalAlign: [['left', 'Links'], ['center', 'Mitte'], ['right', 'Rechts']],
    alignment: [['flex-start', 'Oben'], ['center', 'Mitte'], ['flex-end', 'Unten']], displayMode: [['standard', 'Standard'], ['cover', 'Füllend'], ['stretch', 'Strecken']],
    boxLayout: [['standard', 'Standard'], ['image', 'Großes Bild'], ['minimal', 'Minimal']], boxHeadlineLevel: [1, 2, 3, 4, 5, 6].map(value => [value, `H${value}`]),
    navigationArrows: [['none', 'Keine'], ['inside', 'Innen'], ['outside', 'Außen']], navigationDots: [['none', 'Keine'], ['inside', 'Innen'], ['outside', 'Außen']],
    galleryPosition: [['left', 'Links'], ['underneath', 'Unterhalb']], type: [['contact', 'Kontakt'], ['newsletter', 'Newsletter'], ['revocationRequest', 'Widerruf']],
    productStreamSorting: [['name:ASC', 'Name aufsteigend'], ['name:DESC', 'Name absteigend'], ['cheapestPrice:ASC', 'Preis aufsteigend'], ['cheapestPrice:DESC', 'Preis absteigend'], ['createdAt:ASC', 'Älteste zuerst'], ['createdAt:DESC', 'Neueste zuerst'], ['releaseDate:ASC', 'Erscheinungsdatum aufsteigend'], ['releaseDate:DESC', 'Erscheinungsdatum absteigend'], ['random', 'Zufällig']],
};
export function configDescriptor(type, name, entry = {}) {
    const native = cmsElements.find(element => element.name === type)?.config[name] || entry;
    const descriptor = { name, label: labels[name] || name };
    if (typeof native.value === 'boolean') return { ...descriptor, type: 'boolean' };
    if (choices[name]) return { ...descriptor, type: 'select', options: choices[name] };
    if (['content', 'confirmationText'].includes(name)) return { ...descriptor, type: 'textarea', height: 260 };
    if (name === 'mailReceiver') return { ...descriptor, type: 'lines' };
    if (name === 'sliderItems') return { ...descriptor, type: 'gallery' };
    if (name === 'availableSortings') return { ...descriptor, type: 'sortings' };
    if (name === 'filters') return { ...descriptor, type: 'multiselect', options: [
        ['manufacturer-filter', 'Hersteller'], ['rating-filter', 'Bewertungen'], ['price-filter', 'Preis'], ['shipping-free-filter', 'Versandkostenfrei'], ['property-filter', 'Eigenschaften'],
    ] };
    const entity = (typeof native.entity === 'object' ? native.entity.name : native.entity) || (name === 'propertyWhitelist' ? 'property_group' : name === 'defaultSorting' ? 'product_sorting' : null);
    if (entity) return { ...descriptor, type: 'reference', multiple: Array.isArray(native.value), reference: { entity,
        labelFields: entity === 'media' ? ['fileName'] : entity === 'product_sorting' ? ['label'] : entity === 'emz_instruction' ? ['headline'] : ['name'] } };
    if (typeof native.value === 'number' || ['start', 'end'].includes(name)) return { ...descriptor, type: 'integer', min: 0 };
    if (native.value && typeof native.value === 'object') return { ...descriptor, type: 'json' };
    return descriptor;
}

export function validateSlotConfig(config) {
    for (const [key, item] of Object.entries(config)) {
        if (!item || typeof item !== 'object' || !item.source) throw new Error(`${key}: Die Inhaltsquelle fehlt.`);
        if (item.source === 'mapped' && !/^(product|category)(\.[\w.]+)?$/.test(item.value || '')) throw new Error(`${key}: Bitte eine gültige dynamische Verknüpfung wählen.`);
        if (item.source === 'product_stream' && !/^[a-f0-9]{32}$/.test(item.value || '')) throw new Error('Bitte eine dynamische Produktgruppe wählen.');
        if (item.source !== 'static') continue;
        if (key === 'url') validateLink(item.value);
        if (key === 'sliderItems') for (const image of item.value || []) {
            if (!/^[a-f0-9]{32}$/.test(image.mediaId || '')) throw new Error('Bitte für jedes Galeriebild ein Medium wählen.');
            validateLink(image.url);
        }
        if (key === 'mailReceiver' && (item.value || []).some(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) throw new Error('Bitte gültige Empfänger-E-Mail-Adressen eingeben.');
    }
    if (config.start?.value != null && config.end?.value != null && config.end.value <= config.start.value) throw new Error('Die Endzeit muss nach der Startzeit liegen.');
    return config;
}

export function validateLink(value) {
    if (value && (!/^(https?:\/\/|\/(?!\/)|#|mailto:|tel:)/i.test(value) || /[\u0000-\u0020\\]/.test(value))) throw new Error('Bitte eine gültige Webadresse, einen relativen Pfad, eine E-Mail- oder Telefonverknüpfung eingeben.');
}

export async function loadCmsRecords(api, entity, filter, options = {}, criteria = {}) {
    const records = [];
    for (let page = 1; ; page++) {
        const result = await api.search(entity, { ...criteria, page, limit: 100, filter, sort: [{ field: 'id', order: 'ASC' }] }, options);
        records.push(...result.data);
        if (page * 100 >= result.total) return records;
    }
}
