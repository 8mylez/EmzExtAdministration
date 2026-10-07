import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionChanges, conditionFields } from '../src/Resources/public/js/modules/rule-data.js';
import { entityPayload } from '../src/Resources/public/js/entity-data.js';
import { settingsModules } from '../src/Resources/public/js/modules/settings.js';

test('Regeländerungen unterscheiden neue, bearbeitete und entfernte Bedingungen', () => {
    const original = [
        { id: 'root', parentId: null, type: 'andContainer', position: 0, value: {}, apiAlias: 'rule_condition' },
        { id: 'amount', parentId: 'root', type: 'cartCartAmount', position: 0, value: { operator: '>=', amount: 100 } },
        { id: 'removed', parentId: 'root', type: 'currency', position: 1, value: { operator: '=', currencyIds: ['eur'] } },
    ];
    const current = structuredClone(original.slice(0, 2));
    current[1].value.amount = 150;
    current.push({ id: 'new', parentId: 'root', type: 'customerIsGuest', position: 2, value: { isGuest: false } });
    const changes = conditionChanges(original, current);
    assert.deepEqual(changes.delete, [{ id: 'removed' }]);
    assert.deepEqual(changes.upsert.map(item => item.id), ['amount', 'new']);
    assert.equal(changes.upsert[0].value.amount, 150);
    assert.equal(original[1].value.amount, 100);
});

test('Unbekannte Regelbedingungen bleiben beim Bearbeiten anderer Bedingungen unangetastet', () => {
    const original = [{ id: 'custom', type: 'appScriptCondition', parentId: null, position: 0,
        value: { appValue: ['a', 'b'] }, scriptId: 'plugin-script', customFields: { keep: true } }];
    assert.deepEqual(conditionChanges(original, structuredClone(original)), { upsert: [], delete: [] });
});

test('Regelschema übernimmt Operatoren, Auswahltypen und Filter aus der API', () => {
    const fields = conditionFields({ operatorSet: { operators: ['=', '!='] }, fields: {
        ids: { type: 'multi-entity-id-select', config: { entity: 'customer_group', criteria: { filters: [{ type: 'equals', field: 'active', value: true }] } } },
    } });
    assert.deepEqual(fields[0].options.map(([operator]) => operator), ['=', '!=']);
    assert.equal(fields[1].multiple, true);
    assert.equal(fields[1].reference.entity, 'customer_group');
    assert.deepEqual(fields[1].reference.filter, [{ type: 'equals', field: 'active', value: true }]);
});

test('Cash-Rounding-Update schreibt nur echte Konfiguration und erhält unberührte Rundungswerte', () => {
    const definition = settingsModules.find(module => module.id === 'currencies');
    const original = { itemRounding: { decimals: 2, interval: 0.05, roundForNet: false, apiAlias: 'cash_rounding_config', extensions: [] } };
    const payload = entityPayload(definition, { 'itemRounding.decimals': 3 }, original, new Set(['itemRounding.decimals']));
    assert.deepEqual(definition.prepare(payload), { itemRounding: { decimals: 3, interval: 0.05, roundForNet: false } });
    assert.equal(original.itemRounding.apiAlias, 'cash_rounding_config');
});
