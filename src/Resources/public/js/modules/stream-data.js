const filterKeys = ['id', 'parentId', 'type', 'field', 'operator', 'value', 'parameters', 'position'];
export function streamFilterChanges(original, current) {
    const clean = record => Object.fromEntries(filterKeys.map(key => [key, record[key] ?? null]));
    const old = new Map(original.map(record => [record.id, JSON.stringify(clean(record))]));
    const ids = new Set(current.map(record => record.id));
    return { upsert: current.filter(record => old.get(record.id) !== JSON.stringify(clean(record))).map(clean),
        delete: original.filter(record => !ids.has(record.id)).map(record => ({ id: record.id })) };
}

export function streamQueries(filters, parentId = null, parentType = null, visited = new Set()) {
    return filters.filter(filter => (filter.parentId || null) === parentId).sort((a, b) => a.position - b.position).map(filter => {
        if (visited.has(filter.id)) throw new Error('Die Filterstruktur enthält einen Kreis.');
        const path = new Set(visited); path.add(filter.id);
        if (['multi', 'not'].includes(filter.type)) {
            const queries = streamQueries(filters, filter.id, filter.type, path);
            if (!queries.length) throw new Error('Jede Filtergruppe benötigt mindestens eine Bedingung.');
            return { type: filter.type, operator: filter.operator || 'AND', queries };
        }
        const mapped = { type: filter.type, field: filter.field, value: filter.value, parameters: filter.parameters };
        if (['id', 'product.id'].includes(filter.field) && !String(filter.value ?? '').trim()) throw new Error('Bitte ein Produkt für den Produktfilter auswählen.');
        if (['id', 'product.id'].includes(filter.field)) return { type: 'multi', operator: filter.type === 'equalsAny' && parentType === 'not' ? 'AND' : 'OR',
            queries: [mapped, { ...mapped, field: 'parentId' }] };
        return mapped;
    });
}

export const streamFields = [
    ['id', 'Produkt', 'product'], ['name', 'Produktname'], ['productNumber', 'Produktnummer'], ['description', 'Beschreibung'],
    ['active', 'Aktiv', 'boolean'], ['stock', 'Bestand', 'number'], ['availableStock', 'Verfügbarer Bestand', 'number'],
    ['cheapestPrice', 'Günstigster Preis', 'number'], ['cheapestPrice.percentage', 'Rabatt in Prozent', 'number'],
    ['manufacturer.id', 'Hersteller', 'product_manufacturer'], ['categoriesRo.id', 'Kategorie', 'category'], ['tags.id', 'Tag', 'tag'],
    ['properties.id', 'Eigenschaftsausprägung', 'property_group_option'], ['properties.group.id', 'Eigenschaft', 'property_group'],
    ['options.id', 'Variantenausprägung', 'property_group_option'], ['options.group.id', 'Varianteneigenschaft', 'property_group'],
    ['visibilities.salesChannel.id', 'Verkaufskanal', 'sales_channel'], ['deliveryTime.id', 'Lieferzeit', 'delivery_time'],
    ['shippingFree', 'Versandkostenfrei', 'boolean'], ['isCloseout', 'Abverkauf', 'boolean'], ['markAsTopseller', 'Hervorgehoben', 'boolean'],
    ['weight', 'Gewicht', 'number'], ['width', 'Breite', 'number'], ['height', 'Höhe', 'number'], ['length', 'Länge', 'number'],
    ['ratingAverage', 'Durchschnittliche Bewertung', 'number'], ['sales', 'Verkäufe', 'number'], ['ean', 'EAN'], ['manufacturerNumber', 'Herstellernummer'],
    ['releaseDate', 'Veröffentlichung', 'datetime'], ['createdAt', 'Erstellt am', 'datetime'], ['coverId', 'Titelbild-ID'], ['type', 'Produkttyp'],
];
