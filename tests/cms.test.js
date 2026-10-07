import test from 'node:test';
import assert from 'node:assert/strict';
import { cmsBlocks, cmsElements } from '../src/Resources/public/js/modules/cms-catalog.js';
import { blockSlots, elementConfig, configDescriptor, validateSlotConfig } from '../src/Resources/public/js/modules/cms-config.js';

test('Alle installierten Standard-CMS-Blöcke liefern voneinander unabhängige, vollständige Elementkonfigurationen', () => {
    assert.equal(cmsBlocks.length, 39); assert.equal(cmsElements.length, 20);
    const ids = new Set();
    for (const block of cmsBlocks) {
        const slots = blockSlots(block.name, block.allowedPageTypes?.[0] || 'page');
        assert.ok(slots.length > 0);
        for (const slot of slots) {
            assert.ok(cmsElements.some(element => element.name === slot.type), slot.type);
            assert.ok(!ids.has(slot.id)); ids.add(slot.id);
            assert.deepEqual(Object.keys(slot.config).sort(), Object.keys(elementConfig(slot.type)).sort());
        }
    }
    const first = blockSlots('image-simple-grid', 'page'); first[0].config.displayMode.value = 'changed';
    assert.equal(blockSlots('image-simple-grid', 'page')[0].config.displayMode.value, 'cover');
    assert.throws(() => blockSlots('product-heading', 'page'), /Seitentyp/);
});

test('CMS-Konfiguration akzeptiert dynamische Quellen und prüft Links, Videozeiten und Galeriebilder', () => {
    const config = { product: { source: 'mapped', value: 'product' }, content: { source: 'mapped', value: 'category.name' } };
    assert.equal(validateSlotConfig(config), config);
    assert.throws(() => validateSlotConfig({ url: { source: 'static', value: 'javascript:alert(1)' } }), /Webadresse/);
    assert.throws(() => validateSlotConfig({ url: { source: 'static', value: '//example.invalid' } }), /Webadresse/);
    assert.throws(() => validateSlotConfig({ start: { source: 'static', value: 30 }, end: { source: 'static', value: 10 } }), /Endzeit/);
    assert.throws(() => validateSlotConfig({ sliderItems: { source: 'static', value: [{ mediaId: 'missing' }] } }), /Medium/);
    assert.equal(configDescriptor('product-slider', 'products').multiple, true);
    assert.equal(configDescriptor('image', 'media').reference.entity, 'media');
});
