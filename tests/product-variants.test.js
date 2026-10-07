import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variantPlan } from '../src/Resources/public/js/variant-data.js';
import { replaceCurrencyPrice, validatePriceTier } from '../src/Resources/public/js/price-data.js';

test('Variant plan respects existing combinations, restrictions and number collisions', () => {
    const setting = (id, groupId) => ({ optionId: id, option: { id, groupId, name: id } });
    const product = { id: 'parent', productNumber: 'P', variantRestrictions: [{ values: [{ options: ['blue'] }, { options: [{ optionId: 'xl' }] }] }] };
    const existing = { first: { options: ['red', 's'], productNumber: 'P.1' }, unrelated: { options: ['old'], productNumber: 'P.2' } };
    const plan = variantPlan(product, [setting('red', 'color'), setting('blue', 'color'), setting('s', 'size'), setting('xl', 'size')], existing, [], 'eur');
    assert.deepEqual(plan.map(row => [row.productNumber, row.options.map(option => option.id)]), [['P.3', ['red', 'xl']], ['P.4', ['blue', 's']]]);
    assert.equal('price' in plan[0], false);
    assert.equal(plan[0].stock, 0);
});

test('Variant surcharges add across groups and convert the missing currency', () => {
    const product = { id: 'p', productNumber: 'P', price: [{ currencyId: 'eur', gross: 119, net: 100, linked: true }] };
    const settings = ['a', 'b'].map(id => ({ optionId: id, option: { groupId: id, name: id }, price: [{ currencyId: 'usd', gross: 10, net: 8, linked: false }] }));
    const [variant] = variantPlan(product, settings, {}, [{ id: 'usd', factor: 2 }], 'eur');
    assert.deepEqual(variant.price, [{ currencyId: 'usd', gross: 258, net: 216, linked: false }, { currencyId: 'eur', gross: 119, net: 100, linked: true }]);
});

test('Currency edits preserve other currencies and strip response struct metadata', () => {
    const prices = [{ currencyId: 'eur', gross: 119, net: 100, linked: true, apiAlias: 'price', listPrice: { gross: 200, net: 180, linked: false, extensions: [] } },
        { currencyId: 'usd', gross: 20, net: 18, linked: false }];
    const result = replaceCurrencyPrice(prices, { currencyId: 'usd', gross: 30, net: 25, linked: false });
    assert.deepEqual(result[0], { currencyId: 'eur', gross: 119, net: 100, linked: true, listPrice: { gross: 200, net: 180, linked: false } });
    assert.equal(result[1].gross, 30);
    assert.equal(prices[1].gross, 20);
});

test('Tier validation rejects overlapping and invalid ranges but permits contiguous ranges and other rules', () => {
    const tiers = [{ id: 'a', ruleId: 'r', quantityStart: 1, quantityEnd: 10 }];
    assert.throws(() => validatePriceTier({ ruleId: 'r', quantityStart: 10, quantityEnd: null }, tiers), /überschneidet/);
    assert.throws(() => validatePriceTier({ ruleId: 'r', quantityStart: 2, quantityEnd: 1 }, tiers), /Endmenge/);
    assert.doesNotThrow(() => validatePriceTier({ ruleId: 'r', quantityStart: 11, quantityEnd: null }, tiers));
    assert.doesNotThrow(() => validatePriceTier({ ruleId: 'different', quantityStart: 1, quantityEnd: null }, tiers));
    assert.doesNotThrow(() => validatePriceTier({ ruleId: 'r', quantityStart: 1, quantityEnd: 10 }, tiers, 'a'));
});
