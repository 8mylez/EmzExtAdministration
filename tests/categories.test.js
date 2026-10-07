import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCategories, validateCategoryParent, writeCategory } from '../src/Resources/public/js/modules/categories.js';

test('Kategoriekette behandelt ungeordnete, verwaiste und zyklische Einträge vollständig', () => {
    assert.deepEqual(orderCategories([{ id: 'c', afterCategoryId: 'b' }, { id: 'a', afterCategoryId: null }, { id: 'b', afterCategoryId: 'a' }]).map(item => item.id), ['a', 'b', 'c']);
    assert.equal(new Set(orderCategories([{ id: 'a', afterCategoryId: 'b' }, { id: 'b', afterCategoryId: 'a' }, { id: 'c', afterCategoryId: 'missing' }]).map(item => item.id)).size, 3);
});

test('Kategorie kann weder unter sich selbst noch einen Nachkommen verschoben werden', async () => {
    const api = { search: async () => ({ data: [{ id: 'child', path: '|root|parent|' }] }) };
    await assert.rejects(validateCategoryParent(api, 'parent', 'child'), /Unterkategorien/);
    await assert.rejects(validateCategoryParent(api, 'child', 'child'), /Unterkategorien/);
    await validateCategoryParent(api, 'sibling', 'child');
});

test('Verschieben repariert beide Reihenfolgen in einer Sync-Anfrage', async () => {
    const source = [{ id: 'a', parentId: 'root', afterCategoryId: null }, { id: 'b', parentId: 'root', afterCategoryId: 'a' }, { id: 'c', parentId: 'root', afterCategoryId: 'b' }]; let operation;
    const api = { search: async (entity, criteria) => criteria.ids ? { data: criteria.ids[0] === 'target' ? [{ id: 'target', path: '|root|' }] : [source[1]] }
        : { data: criteria.filter[0].value === 'root' ? source : [], total: criteria.filter[0].value === 'root' ? 3 : 0 }, request: async (path, method, body) => { operation = { path, method, body }; } };
    await writeCategory(api, '/category/b', 'PATCH', { parentId: 'target', name: 'Verschoben' });
    assert.equal(operation.path, '/_action/sync');
    assert.deepEqual(operation.body.categories.payload, [{ id: 'a', parentId: 'root', afterCategoryId: null }, { id: 'c', parentId: 'root', afterCategoryId: 'a' }, { id: 'b', parentId: 'target', afterCategoryId: null, name: 'Verschoben' }]);
});
