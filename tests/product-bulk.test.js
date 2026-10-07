import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkProductPayload } from '../src/Resources/public/js/product-bulk.js';

test('Massenänderungen schreiben nur ausgewählte Felder und erhalten fremde Währungen und Streichpreise', () => {
    const original = { id: 'p', stock: 3, taxId: 'tax', price: [{ currencyId: 'eur', gross: 119, net: 100, linked: true, listPrice: { gross: 130, net: 109, linked: false } }, { currencyId: 'usd', gross: 140, net: 140, linked: false }] };
    const fields = [{ name: 'stock', label: 'Bestand', type: 'integer' }];
    assert.deepEqual(bulkProductPayload(original, fields, { stock: 7 }, new Set(['stock']), null, 'eur', []), { id: 'p', stock: 7 });
    const result = bulkProductPayload(original, fields, {}, new Set(), { mode: 'percent', value: 10 }, 'eur', [{ id: 'tax', taxRate: 19 }]);
    assert.equal(result.price.find(price => price.currencyId === 'eur').gross, 130.9);
    assert.equal(result.price.find(price => price.currencyId === 'eur').net, 110);
    assert.deepEqual(result.price.find(price => price.currencyId === 'usd'), original.price[1]);
    assert.deepEqual(result.price.find(price => price.currencyId === 'eur').listPrice, original.price[0].listPrice);
    assert.equal(original.price[0].gross, 119);
});
