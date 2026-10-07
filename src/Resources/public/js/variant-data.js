export function variantPlan(product, settings, existing, currencies, currencyId) {
    const groups = new Map();
    for (const setting of settings) {
        const option = setting.option;
        if (!option?.groupId) throw new Error('Eine Variantenoption hat keine Eigenschaftsgruppe. Bitte die Optionen aktualisieren.');
        if (!groups.has(option.groupId)) groups.set(option.groupId, []);
        if (!groups.get(option.groupId).some(item => item.optionId === setting.optionId)) groups.get(option.groupId).push(setting);
    }
    if (!groups.size) throw new Error('Bitte zuerst im Reiter Variantenoptionen Ausprägungen zuordnen.');
    const count = [...groups.values()].reduce((total, options) => total * options.length, 1);
    if (count > 10000) throw new Error(`${count} Kombinationen: Bitte die Optionen aufteilen (höchstens 10.000 Kombinationen pro Vorschau).`);
    const combinations = [...groups.values()].reduce((rows, options) => rows.flatMap(row => options.map(option => [...row, option])), [[]]);
    const signature = options => options.map(option => typeof option === 'string' ? option : option.id).sort().join('|');
    const known = new Set(Object.values(existing).map(variant => signature(variant.options)));
    const numbers = new Set(Object.values(existing).map(variant => variant.productNumber));
    let sequence = 1;
    return combinations.filter(options => {
        const ids = options.map(option => option.optionId);
        if (known.has(signature(ids))) return false;
        return !(product.variantRestrictions || []).some(restriction => restriction.values?.length && restriction.values.every(value =>
            value.options?.some(option => ids.includes(typeof option === 'string' ? option : option.optionId))));
    }).map(options => {
        let productNumber;
        do { productNumber = `${product.productNumber}.${sequence++}`; } while (numbers.has(productNumber));
        numbers.add(productNumber);
        const price = surchargePrice(product.price, options, currencies, currencyId);
        return { parentId: product.id, productNumber, stock: 0, ...(product.type ? { type: product.type } : {}), options: options.map(option => ({ id: option.optionId })),
            label: options.map(option => `${option.option.group?.name || 'Ausprägung'}: ${option.option.name}`).join(' · '),
            ...(price.length ? { price } : {}) };
    });
}

function surchargePrice(prices, settings, currencies, currencyId) {
    const result = new Map();
    for (const setting of settings) {
        for (const extra of setting.price || []) {
            const source = prices?.find(price => price.currencyId === extra.currencyId);
            const base = prices?.find(price => price.currencyId === currencyId);
            const currency = currencies.find(item => item.id === extra.currencyId);
            if (!source && (!base || !currency)) throw new Error('Währung oder Grundpreis für einen Variantenaufschlag fehlt.');
            const previous = result.get(extra.currencyId) || source || { gross: base.gross * currency.factor, net: base.net * currency.factor };
            const gross = Math.round((previous.gross + extra.gross) * 1e8) / 1e8;
            const net = Math.round((previous.net + extra.net) * 1e8) / 1e8;
            if (gross < 0 || net < 0) throw new Error('Ein Variantenabschlag würde einen negativen Preis ergeben.');
            result.set(extra.currencyId, { currencyId: extra.currencyId, gross, net, linked: extra.linked });
        }
    }
    if (result.size && !result.has(currencyId)) {
        const base = prices?.find(price => price.currencyId === currencyId);
        if (!base) throw new Error('Der Standardpreis fehlt.');
        result.set(currencyId, { currencyId, gross: base.gross, net: base.net, linked: base.linked });
    }
    return [...result.values()];
}
