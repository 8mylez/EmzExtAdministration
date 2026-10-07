import test from 'node:test';
import assert from 'node:assert/strict';
import { streamQueries, streamFilterChanges } from '../src/Resources/public/js/modules/stream-data.js';

test('Product stream ID exclusion preserves Shopware parent/variant semantics', () => {
    const filters = [{ id: 'root', type: 'not', operator: 'AND' }, { id: 'id', parentId: 'root', type: 'equalsAny', field: 'id', value: 'a|b', position: 0 }];
    const query = streamQueries(filters)[0];
    assert.equal(query.type, 'not'); assert.equal(query.queries[0].operator, 'AND');
    assert.deepEqual(query.queries[0].queries.map(filter => filter.field), ['id', 'parentId']);
    assert.equal(query.queries[0].queries[0].value, 'a|b');
});

test('Product stream changes preserve untouched extension filters and delete explicit removals', () => {
    const original = [{ id: 'a', type: 'extension', parameters: { unknown: [1, 2] }, position: 0 }, { id: 'b', type: 'equals', field: 'stock', value: '2', position: 1 }];
    const current = [structuredClone(original[0]), { id: 'c', parentId: 'a', type: 'equals', field: 'active', value: '1' }];
    const changes = streamFilterChanges(original, current);
    assert.deepEqual(changes.delete, [{ id: 'b' }]); assert.deepEqual(changes.upsert.map(filter => filter.id), ['c']);
    assert.deepEqual(original[0].parameters, { unknown: [1, 2] });
});

test('Product streams reject empty groups and empty product selections before saving', () => {
    assert.throws(() => streamQueries([{ id: 'a', type: 'multi', operator: 'OR' }]), /mindestens eine Bedingung/);
    assert.throws(() => streamQueries([{ id: 'a', type: 'equalsAny', field: 'id', value: '' }]), /Produkt/);
});
