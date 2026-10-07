import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowTree } from '../src/Resources/public/js/modules/flow-tree.js';
import { prepareFlowAction } from '../src/Resources/public/js/modules/flow-actions.js';

test('Flow-Baum erhält Ja-/Nein-Zweige und Aktionsketten', () => {
    const tree = buildFlowTree([
        { id: 'root', parentId: null, ruleId: 'r', position: 1 },
        { id: 'yes', parentId: 'root', trueCase: true, actionName: 'one', position: 1 },
        { id: 'no', parentId: 'root', trueCase: false, actionName: 'two', position: 1 },
        { id: 'next', parentId: 'yes', actionName: 'three', position: 1 },
    ], step => step.id);
    assert.equal(tree[0].children[0].children[0].stepId, 'yes');
    assert.equal(tree[0].children[0].children[0].children[0].stepId, 'next');
    assert.equal(tree[0].children[1].children[0].stepId, 'no');
    assert.throws(() => buildFlowTree([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], step => step.id), /zyklisch/);
});

test('Flow-Dokumentauswahl erhält bestehende Einstellungen und konvertiert das ältere Einzelformat', () => {
    const old = { config: { documentType: 'invoice', documentRangerType: 'document_invoice', fileType: 'html', config: { documentComment: 'Behalten' } } };
    const payload = prepareFlowAction('action.generate.document', { config: { ...old.config, documentTypes: ['invoice', 'delivery_note'] } }, old, {});
    assert.equal(payload.config.documentType, undefined);
    assert.equal(payload.config.documentTypes[0].fileType, 'html');
    assert.equal(payload.config.documentTypes[0].config.documentComment, 'Behalten');
    assert.equal(payload.config.documentTypes[1].documentRangerType, 'document_delivery_note');
});
