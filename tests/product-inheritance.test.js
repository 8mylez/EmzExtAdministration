import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProductInheritance, resolvedProductValues } from '../src/Resources/public/js/product-inheritance.js';

test('Geerbte Übersetzungen stammen aus translated, während der eigene Rohwert unverändert bleibt', () => {
    const record = { name: null, description: null, translated: { name: 'Hauptprodukt', description: 'Beschreibung' } };
    assert.equal(resolvedProductValues(record).description, 'Beschreibung');
    assert.equal(record.description, null);
});

test('Vererbung löscht nur abgewählte eigene Werte und erlaubt explizite Werte identisch zum Hauptprodukt', () => {
    const payload = { name: 'Hauptprodukt', description: 'Text', stock: 4, price: [{ gross: 5 }] };
    applyProductInheritance(payload, new Map([['name', true], ['description', false], ['price', true], ['active', true]]),
        { name: 'Eigener Name', description: null, price: [{ gross: 5 }], active: null }, { description: 'Text' }, [], [], 'currency');
    assert.deepEqual(payload, { name: null, description: 'Text', stock: 4, price: null });
});
