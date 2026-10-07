export const rootProducts = [{ type: 'equals', field: 'parentId', value: null }];

export function productCriteria({ page = 1, term = '', status = 'all', sort = 'updatedAt', direction = 'DESC' } = {}) {
    const filter = [...rootProducts];
    if (status !== 'all') filter.push({ type: 'equals', field: 'active', value: status === 'active' });
    return {
        page, limit: 25, 'total-count-mode': 1, filter,
        sort: [{ field: sort, order: direction }, { field: 'id', order: 'ASC' }],
        ...(term.trim() ? { term: term.trim() } : {}),
    };
}

export function productPayload(values, product, currencyId, changedFields) {
    const payload = {};
    const fields = ['name', 'productNumber', 'stock', 'active', 'taxId', 'description'];
    for (const field of fields) {
        if (!product || values[field] !== (product[field] ?? '')) payload[field] = values[field];
    }
    const original = product?.price?.find(price => price.currencyId === currencyId);
    const price = { currencyId, gross: values.gross, net: values.net, linked: values.linked };
    const priceEdited = !changedFields || ['gross', 'net', 'linked'].some(field => changedFields.has(field));
    if (!product || (priceEdited && (!original || ['gross', 'net', 'linked'].some(field => original[field] !== price[field])))) {
        // Preserve prices in other currencies and list/regulation prices not edited by this MVP.
        payload.price = [...(product?.price || []).filter(item => item.currencyId !== currencyId), { ...original, ...price }];
    }
    return payload;
}

export function defaultPrice(product, currencyId) {
    return product?.price?.find(price => price.currencyId === currencyId) || { gross: 0, net: 0, linked: true };
}
