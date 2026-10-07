import test from 'node:test';
import assert from 'node:assert/strict';
import { productCriteria, productPayload } from '../src/Resources/public/js/products.js';

const product = {
    name: 'Produkt', productNumber: 'TEST-1', stock: 4, active: true, taxId: 'tax', description: null,
    price: [
        { currencyId: 'eur', gross: 19, net: 15.966386554621849, linked: true, listPrice: { gross: 25, net: 21, linked: true } },
        { currencyId: 'usd', gross: 23, net: 20, linked: false },
    ],
};
const values = { ...product, description: '', ...product.price[0] };

test('Bestandsänderung lässt hochpräzise Preise und andere Felder unverändert', () => {
    assert.deepEqual(productPayload({ ...values, stock: 7, net: 15.9664 }, product, 'eur', new Set(['stock'])), { stock: 7 });
});

test('Preisänderung erhält andere Währungen und Streichpreise', () => {
    const result = productPayload({ ...values, gross: 20 }, product, 'eur', new Set(['gross']));
    assert.deepEqual(result.price.find(price => price.currencyId === 'usd'), product.price[1]);
    assert.deepEqual(result.price.find(price => price.currencyId === 'eur').listPrice, product.price[0].listPrice);
    assert.equal(result.price.find(price => price.currencyId === 'eur').gross, 20);
    assert.equal(product.price[0].gross, 19);
});

test('Unveränderte Form erzeugt kein Update; fehlende Preise werden beim Bestandsupdate nicht erfunden', () => {
    assert.deepEqual(productPayload(values, product, 'eur', new Set()), {});
    assert.deepEqual(productPayload({ ...values, stock: 8 }, { ...product, price: [] }, 'eur', new Set(['stock'])), { stock: 8 });
});

test('Suche begrenzt, paginiert und filtert Hauptprodukte serverseitig', () => {
    const criteria = productCriteria({ page: 3, term: ' TEST ', status: 'inactive' });
    assert.equal(criteria.limit, 25);
    assert.equal(criteria.page, 3);
    assert.equal(criteria.term, 'TEST');
    assert.deepEqual(criteria.filter, [{ type: 'equals', field: 'parentId', value: null }, { type: 'equals', field: 'active', value: false }]);
});
