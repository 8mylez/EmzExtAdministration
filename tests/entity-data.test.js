import test from 'node:test';
import assert from 'node:assert/strict';
import { entityPayload, listCriteria } from '../src/Resources/public/js/entity-data.js';

test('Stammdaten-Updates senden nur geänderte und freigegebene Felder', () => {
    const definition = { fields: [{ name: 'name', label: 'Name', required: true }, { name: 'position', label: 'Position', type: 'integer' },
        { name: 'secret', readOnly: true }, { name: 'password', type: 'password' }] };
    assert.deepEqual(entityPayload(definition, { name: ' Neuer Name ', position: 9, secret: 'x', password: '' }, { name: 'Alt' }, new Set(['name', 'secret', 'password'])), { name: 'Neuer Name' });
    assert.deepEqual(entityPayload(definition, { position: 9 }, {}, new Set()), {});
});

test('Bearbeitung einzelner JSON-Einstellungen erhält alle anderen Werte ohne Originalmutation', () => {
    const original = { itemRounding: { decimals: 2, interval: 0.05, roundForNet: false, extra: 7 } };
    const definition = { fields: [{ name: 'itemRounding.decimals', type: 'integer' }] };
    const result = entityPayload(definition, { 'itemRounding.decimals': 3 }, original, new Set(['itemRounding.decimals']));
    assert.deepEqual(result, { itemRounding: { decimals: 3, interval: 0.05, roundForNet: false, extra: 7 } });
    assert.equal(original.itemRounding.decimals, 2);
});

test('Suchfilter behalten den Modulkontext bei und werden serverseitig paginiert', () => {
    const definition = { search: ['firstName', 'email'], filter: [{ type: 'equals', field: 'customerId', value: 'customer' }], sort: 'email' };
    const criteria = listCriteria(definition, { page: 4, term: ' hallo ', active: 'all' });
    assert.equal(criteria.limit, 25);
    assert.equal(criteria.page, 4);
    assert.deepEqual(criteria.filter[0], definition.filter[0]);
    assert.equal(criteria.filter[1].queries[0].value, 'hallo');
    assert.equal(criteria.filter[1].operator, 'OR');
});

test('Pflichtfelder und Ganzzahlen werden vor dem Schreiben validiert', () => {
    assert.throws(() => entityPayload({ fields: [{ name: 'name', label: 'Name', required: true }] }, { name: ' ' }), /darf nicht leer/);
    assert.throws(() => entityPayload({ fields: [{ name: 'count', label: 'Anzahl', type: 'integer' }] }, { count: 2.5 }), /gültige Zahl/);
});

test('Geburtstag bleibt ein Kalendertag; Aktionszeitpunkt behält Uhrzeit und Zeitzone', () => {
    const definition = { fields: [{ name: 'birthday', type: 'date', dateOnly: true }, { name: 'validFrom', type: 'datetime' }] };
    const result = entityPayload(definition, { birthday: new Date(1990, 6, 15), validFrom: '2026-10-06T10:30:00+02:00' });
    assert.equal(result.birthday, '1990-07-15');
    assert.equal(result.validFrom, '2026-10-06T08:30:00.000Z');
});

test('Leere Shopware-JSON-Arrays werden beim Ergänzen benannter Optionen zu Objekten', () => {
    const original = { config: [] };
    const payload = entityPayload({ fields: [{ name: 'config.active', type: 'boolean' }] }, { 'config.active': true }, original, new Set(['config.active']));
    assert.equal(JSON.stringify(payload), '{"config":{"active":true}}');
    assert.deepEqual(original.config, []);
});

test('Passwörter behalten bewusst eingegebene Leerzeichen', () => {
    const payload = entityPayload({ fields: [{ name: 'password', type: 'password', required: true }] }, { password: ' Test-Passphrase ' });
    assert.equal(payload.password, ' Test-Passphrase ');
});
