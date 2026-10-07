export function cleanPrice(price) {
    const result = { currencyId: price.currencyId, gross: price.gross, net: price.net, linked: Boolean(price.linked) };
    for (const key of ['listPrice', 'regulationPrice']) {
        if (price[key]) result[key] = { gross: price[key].gross, net: price[key].net, linked: Boolean(price[key].linked) };
    }
    return result;
}

export function replaceCurrencyPrice(prices, price) {
    const result = (prices || []).filter(item => item.currencyId !== price.currencyId).map(cleanPrice);
    result.push(cleanPrice(price));
    return result;
}

export function validatePriceTier(values, tiers, id) {
    const start = values.quantityStart;
    const end = values.quantityEnd ?? Infinity;
    if (!Number.isInteger(start) || start < 1 || (end !== Infinity && (!Number.isInteger(end) || end < start))) {
        throw new Error('Die Preisstaffel muss bei mindestens 1 beginnen; die Endmenge muss mindestens der Startmenge entsprechen.');
    }
    if (tiers.some(tier => tier.id !== id && tier.ruleId === values.ruleId
        && start <= (tier.quantityEnd ?? Infinity) && end >= tier.quantityStart)) {
        throw new Error('Diese Mengenstaffel überschneidet sich mit einem vorhandenen Preis derselben Regel.');
    }
}
