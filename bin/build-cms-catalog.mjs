// Extract the installed Shopware CMS catalog. Only registration metadata is retained.
import { readFileSync, writeFileSync, globSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const source = resolve(root, 'vendor/shopware/administration/Resources/app/administration/src/module/sw-cms');
const snippets = JSON.parse(readFileSync(`${source}/snippet/de.json`, 'utf8'));
const blocks = []; const elements = [];
const label = key => key.split('.').reduce((data, part) => data?.[part], snippets) || key;
const config = values => Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, {
    source: value.source, value: value.value, ...(value.entity ? { entity: value.entity.name } : {}),
}]));
const constants = readFileSync(`${source}/elements/image/config.constant.ts`, 'utf8').replace(/export \{[^}]+\};/, '');
const service = {
    getCollectFunction: () => undefined,
    registerCmsElement: element => elements.push({ name: element.name, label: label(element.label), config: config(element.defaultConfig), allowedPageTypes: element.allowedPageTypes }),
    registerCmsBlock: block => blocks.push({ name: block.name, label: label(block.label), category: block.category, allowedPageTypes: block.allowedPageTypes,
        defaults: Object.fromEntries(Object.entries(block.defaultConfig || {}).filter(([name]) => name !== 'sizingMode')),
        slots: Object.fromEntries(Object.entries(block.slots).map(([name, slot]) => [name, typeof slot === 'string' ? { type: slot } : { type: slot.type, config: config(slot.default?.config) }])),
    }),
};
class Criteria { addAssociation() { return this; } }
const Shopware = { Component: { register() {}, extend() {} }, Data: { Criteria }, Service: () => service,
    Constants: { CMS: { PAGE_TYPES: { LISTING: 'product_list', PRODUCT_DETAIL: 'product_detail' }, MEDIA: {} } } };
for (const pattern of ['elements/*/index.ts', 'blocks/*/*/index.ts']) {
    for (const file of globSync(`${source}/${pattern}`).sort()) {
        const code = readFileSync(file, 'utf8');
        if (!code.includes('registerCms')) continue;
        runInNewContext(stripTypeScriptTypes(`${constants}\n${code.replace(/^import .*;$/gm, '')}`), { Shopware }, { filename: file, timeout: 1000 });
    }
}
const version = JSON.parse(readFileSync(resolve(root, 'composer.lock'), 'utf8')).packages.find(pkg => pkg.name === 'shopware/core').version;
const serialize = list => `[\n${list.map(item => `    ${JSON.stringify(item)}`).join(',\n')}\n]`;
writeFileSync(new URL('../src/Resources/public/js/modules/cms-catalog.js', import.meta.url),
    `// Generated from Shopware ${version} (MIT), sw-cms registration metadata.\n// Regenerate: node custom/plugins/EmzExtAdministration/bin/build-cms-catalog.mjs\nexport const cmsBlocks = ${serialize(blocks)};\nexport const cmsElements = ${serialize(elements)};\n`);
process.stdout.write(`${blocks.length} blocks, ${elements.length} elements (${version})\n`);
