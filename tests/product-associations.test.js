import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkAssociationChange } from '../src/Resources/public/js/product-bulk.js';

test('Massenänderung erhält geerbte Zuordnungen beim Ergänzen und materialisiert nur benötigte Werte', () => {
    const product = { id: 'variant', parentId: 'parent', productNumber: 'P.1' }; const relation = { title: 'Tags' };
    assert.deepEqual(bulkAssociationChange(product, relation, [], ['a', 'b'], 'add', ['c']), { add: ['a', 'b', 'c'], remove: [] });
    assert.deepEqual(bulkAssociationChange(product, relation, ['a', 'c'], ['a', 'b'], 'replace', ['b', 'c']), { add: ['b'], remove: ['a'] });
    assert.deepEqual(bulkAssociationChange(product, relation, ['c'], ['a'], 'inherit', []), { add: [], remove: ['c'] });
    assert.throws(() => bulkAssociationChange(product, relation, [], ['a'], 'remove', ['a']), /erbt die Variante/);
    assert.throws(() => bulkAssociationChange({ productNumber: 'P' }, relation, [], [], 'inherit', []), /Nur Varianten/);
});
