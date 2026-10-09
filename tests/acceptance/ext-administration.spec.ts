import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmsBlocks } from '../../../custom/plugins/EmzExtAdministration/src/Resources/public/js/modules/cms-catalog.js';
import { blockSlots } from '../../../custom/plugins/EmzExtAdministration/src/Resources/public/js/modules/cms-config.js';

test.use({ actionTimeout: 10000 });

let username = process.env.SHOPWARE_ADMIN_USERNAME || '';
let password = process.env.SHOPWARE_ADMIN_PASSWORD || '';
let testUserId: string | undefined;

async function integrationHeaders(request) {
    const response = await request.post('/api/oauth/token', { data: {
        grant_type: 'client_credentials', client_id: process.env.SHOPWARE_ACCESS_KEY_ID,
        client_secret: process.env.SHOPWARE_SECRET_ACCESS_KEY,
    } });
    expect(response.ok(), 'Test-Integration muss in tests/acceptance/.env konfiguriert sein').toBeTruthy();
    return { Authorization: `Bearer ${(await response.json()).access_token}`, Accept: 'application/json' };
}

test.beforeAll(async ({ request }) => {
    if (username && password) return;
    const headers = await integrationHeaders(request);
    const locales = await request.post('/api/search/locale', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'code', value: 'de-DE' }] } });
    const id = randomUUID().replaceAll('-', '');
    username = `emz-mvp-test-${id}`;
    password = randomUUID();
    const created = await request.post('/api/user', { headers, data: {
        id, username, password, firstName: 'MVP', lastName: 'Browsertest', email: `${username}@example.invalid`,
        localeId: (await locales.json()).data[0].id, active: true, admin: true,
    } });
    expect(created.ok()).toBeTruthy();
    testUserId = id;
});

test.afterAll(async ({ request }) => {
    if (testUserId) {
        const response = await request.delete(`/api/user/${testUserId}`, { headers: await integrationHeaders(request) });
        expect(response.ok()).toBeTruthy();
    }
});

async function login(page, credentials = { username, password }) {
    await page.goto('/admin');
    await page.getByRole('textbox', { name: 'Benutzername' }).fill(credentials.username);
    await page.getByLabel('Passwort', { exact: false }).fill(credentials.password);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dein Shop im Überblick' })).toBeVisible();
}

test('Alle Administrationsmodule laden auf Desktop und Tablet ohne Browser- oder API-Fehler', async ({ page }) => {
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(new URL(response.url()).pathname + ': ' + response.status()); });
    await page.setViewportSize({ width: 1440, height: 1000 }); await login(page);
    const modules = await page.evaluate(async () => (await import('/bundles/emzextadministration/js/modules/index.js')).modules.map(({ id, title }) => ({ id, title })));
    expect(modules.length).toBeGreaterThanOrEqual(73);
    for (const module of modules) {
        await test.step(module.title, async () => {
            await page.evaluate(id => { location.hash = id; }, module.id);
            const dialog = page.getByRole('dialog', { name: module.title, exact: true });
            await expect(dialog).toBeVisible();
            await expect(dialog.locator('.x-mask-msg:visible')).toHaveCount(0);
            await expect(page.getByRole('alertdialog')).not.toBeVisible();
            await dialog.getByRole('button', { name: 'Schließen', exact: true }).first().click();
            await expect(dialog).not.toBeVisible();
        });
    }
    await page.evaluate(() => { location.hash = 'products'; });
    const products = page.getByRole('dialog', { name: 'Produkte', exact: true }); await expect(products.getByText(/Seite 1 von/)).toBeVisible();
    await page.screenshot({ path: '/tmp/emz-ext-admin-desktop.png' });
    await page.setViewportSize({ width: 1024, height: 768 });
    await products.getByRole('button', { name: 'Maximieren', exact: true }).click();
    await expect(products.getByRole('button', { name: 'Schließen', exact: true })).toBeInViewport();
    await expect(products.getByRole('button', { name: 'Produkt anlegen', exact: true })).toBeInViewport();
    await page.screenshot({ path: '/tmp/emz-ext-admin-tablet.png' });
    expect(errors).toEqual([]);
});

test('Systemwerkzeuge und zusätzliche Konfigurationen laden mit echten API-Daten', async ({ page, request }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${new URL(response.url()).pathname}: ${response.status()}`); });
    await login(page);
    await page.evaluate(() => { location.hash = 'cache'; });
    await expect(page.getByRole('dialog', { name: 'Cache & Indizes', exact: true }).getByText(/Umgebung:/)).toBeVisible();
    for (const [id, title] of [['logs', 'Ereignisprotokoll'], ['scheduled-tasks', 'Geplante Aufgaben']]) {
        await page.evaluate(id => { location.hash = id; }, id);
        await expect(page.getByRole('dialog', { name: title, exact: true }).getByText(/Seite 1 von/)).toBeVisible();
    }
    for (const [id, title, domain] of [['config-mailerSettings', 'E-Mail-Versand', 'mailerSettings'], ['config-systemWideLoginRegistration', 'Kundenkonten & Anmeldung', 'systemWideLoginRegistration'], ['config-userPermission', 'Benutzereinstellungen', 'userPermission']]) {
        const [response] = await Promise.all([page.waitForResponse(response => response.url().includes(`/_action/system-config/schema?domain=core.${domain}`)), page.evaluate(id => { location.hash = id; }, id)]);
        expect(response.ok()).toBeTruthy();
        await expect(page.getByRole('dialog', { name: title, exact: true }).getByRole('button', { name: 'Speichern', exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
    const denied = await request.post('/api/_action/emz-ext-admin/message-queue/consume', { data: { receiver: 'async' } });
    expect(denied.status()).toBe(401);
    const invalid = await request.post('/api/_action/emz-ext-admin/message-queue/consume', { headers: await integrationHeaders(request), data: { receiver: 'emz-no-such-transport' } });
    expect(invalid.status()).toBe(400);
});

test('Eigene Dokumentvorlage speichert Firmendaten und erhält andere Konfigurationswerte', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-DOCUMENT-${Date.now()}`; let id: string | undefined;
    const type = (await (await request.post('/api/search/document-type', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'technicalName', value: 'invoice' }] } })).json()).data[0];
    try {
        await login(page); await page.evaluate(() => { location.hash = 'document-settings'; });
        const list = page.getByRole('dialog', { name: 'Dokumentvorlagen', exact: true });
        await list.getByRole('button', { name: 'Dokumentvorlage anlegen', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'Dokumentvorlage anlegen', exact: true });
        await create.getByRole('textbox', { name: /^Name:/ }).fill(name);
        await chooseReference(page, create, 'Belegtyp:', type.name);
        await create.getByRole('textbox', { name: 'Firma:', exact: true }).fill('EMZ Testfirma');
        await create.getByRole('textbox', { name: 'Ort:', exact: true }).fill('Teststadt');
        const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/document-base-config') && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(created.ok(), (await created.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); id = created.request().postDataJSON().id;
        await expect(create).not.toBeVisible(); await list.getByRole('textbox', { name: 'Dokumentvorlagen suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Dokumentvorlage bearbeiten', exact: true });
        await editor.getByRole('textbox', { name: 'Ort:', exact: true }).fill('Geänderte Teststadt');
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(editor).not.toBeVisible();
        const record = (await (await request.post('/api/search/document-base-config', { headers, data: { ids: [id], limit: 1 } })).json()).data[0];
        expect(record.config.companyCity).toBe('Geänderte Teststadt'); expect(record.config.companyName).toBe('EMZ Testfirma'); expect(record.config.pageSize).toBe('a4'); expect(record.global).toBeFalsy();
    } finally { if (id) expect((await request.delete(`/api/document-base-config/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Bestellstatus ohne Mail ändern und eine echte PDF-Rechnung erstellen und herunterladen', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const order = await createTestOrder(request, headers);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        const transitions = (await (await request.get(`/api/_action/state-machine/order/${order.id}/state`, { headers })).json()).transitions;
        const transition = transitions.find(item => item.actionName === 'process') || transitions[0];
        expect(transition).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'orders'; });
        const list = page.getByRole('dialog', { name: 'Bestellungen', exact: true });
        await list.getByRole('textbox', { name: 'Bestellungen suchen', exact: true }).fill(order.orderNumber);
        await list.getByRole('row').filter({ hasText: order.orderNumber }).dblclick();
        const editor = page.getByRole('dialog', { name: `Bestellung ${order.orderNumber}`, exact: true });
        await editor.getByRole('button', { name: 'Bestellstatus ändern', exact: true }).click();
        const state = page.getByRole('dialog', { name: 'Bestellstatus', exact: true });
        await state.getByRole('combobox', { name: 'Neuer Status:', exact: true }).click();
        await page.getByRole('option', { name: transition.name, exact: true }).click();
        await expect(state.getByRole('checkbox')).not.toBeChecked();
        const [changed] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/_action/order/${order.id}/state/${transition.actionName}`) && response.request().method() === 'POST'), state.getByRole('button', { name: 'Status ändern', exact: true }).click()]);
        expect(changed.ok()).toBeTruthy(); expect(changed.request().postDataJSON().sendMail).toBe(false);
        await expect(state).not.toBeVisible();
        const changedOrder = (await (await request.post('/api/search/order', { headers, data: { ids: [order.id], limit: 1 } })).json()).data[0];
        expect(changedOrder.stateId).not.toBe(order.stateId);
        await editor.getByRole('tab', { name: 'Belege', exact: true }).click();
        await editor.getByRole('button', { name: 'Beleg erstellen', exact: true }).click();
        const document = page.getByRole('dialog', { name: 'Beleg erstellen', exact: true });
        const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/order/document/invoice/create') && response.request().method() === 'POST'), document.getByRole('button', { name: 'Beleg erstellen', exact: true }).click()]);
        const result = await created.json(); expect(created.ok()).toBeTruthy(); expect(Object.keys(result.errors || {})).toHaveLength(0);
        await expect(document).not.toBeVisible();
        const docs = (await (await request.post('/api/search/document', { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'orderId', value: order.id }] } })).json()).data;
        expect(docs).toHaveLength(1); expect(docs[0].sent).toBeFalsy();
        const row = editor.getByRole('row').filter({ hasText: docs[0].documentNumber });
        const [download] = await Promise.all([page.waitForEvent('download'), row.dblclick()]);
        const buffer = await readFile((await download.path())!); expect(buffer.subarray(0, 4).toString()).toBe('%PDF'); expect(buffer.length).toBeGreaterThan(1000);
        expect(errors).toEqual([]);
    } finally {
        const docs = (await (await request.post('/api/search/document', { headers, data: { limit: 50, filter: [{ type: 'equals', field: 'orderId', value: order.id }] } })).json()).data;
        for (const document of docs) expect((await request.delete(`/api/document/${document.id}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/order/${order.id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Belegversand liefert die Rechnung als Anhang an das lokale Mailpit', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const order = await createTestOrder(request, headers);
    const templateId = randomUUID().replaceAll('-', ''); const name = 'EMZ-DOCUMENT-MAIL-' + Date.now(); let templateCreated = false;
    const mailpit = (path, method = 'GET', body?) => {
        const args = ['exec', 'curl', '-fsS', '-X', method, 'http://localhost:8025/api/v1' + path];
        if (body) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(body));
        const raw = execFileSync('ddev', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return raw.trim().startsWith('{') ? JSON.parse(raw) : null;
    };
    const messages = () => mailpit('/search?query=' + encodeURIComponent('to:' + order.orderCustomer.email)).messages || [];
    try {
        mailpit('/info');
        const type = (await (await request.post('/api/search/mail-template-type', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'technicalName', value: 'invoice_mail' }] } })).json()).data[0];
        expect((await request.post('/api/mail-template', { headers, data: { id: templateId, mailTemplateTypeId: type.id, description: name, senderName: 'Ext Administration',
            subject: name, contentPlain: 'Rechnung {{ order.orderNumber }}', contentHtml: '<p>Rechnung {{ order.orderNumber }}</p>' } })).ok()).toBeTruthy(); templateCreated = true;
        const created = await request.post('/api/_action/order/document/invoice/create', { headers, data: [{ orderId: order.id, fileType: 'pdf', static: false, config: { documentDate: new Date().toISOString().slice(0, 10) } }] });
        expect(created.ok()).toBeTruthy(); expect(Object.keys((await created.json()).errors || {})).toHaveLength(0);
        const doc = (await (await request.post('/api/search/document', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'orderId', value: order.id }] } })).json()).data[0];
        await login(page); await page.evaluate(() => { location.hash = 'orders'; }); const list = page.getByRole('dialog', { name: 'Bestellungen', exact: true });
        await list.getByRole('textbox', { name: 'Bestellungen suchen', exact: true }).fill(order.orderNumber); await list.getByRole('row').filter({ hasText: order.orderNumber }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Bestellung ' + order.orderNumber, exact: true }); await editor.getByRole('tab', { name: 'Belege', exact: true }).click();
        await editor.getByRole('row').filter({ hasText: doc.documentNumber }).click(); await editor.getByRole('button', { name: 'Beleg per E-Mail senden', exact: true }).click();
        const send = page.getByRole('dialog', { name: 'Beleg per E-Mail senden', exact: true });
        await chooseReference(page, send, 'E-Mail-Vorlage:', name + ' · ' + name, name);
        expect(messages()).toHaveLength(0);
        const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/mail-template/get-data-and-send')), send.getByRole('button', { name: 'E-Mail jetzt senden', exact: true }).click()]);
        expect(response.ok(), (await response.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); await expect(send).not.toBeVisible();
        await expect.poll(async () => {
            if (messages().length) return true;
            await request.post('/api/_action/emz-ext-admin/message-queue/consume', { headers, data: { receiver: 'async' }, timeout: 40000 });
            return messages().length > 0;
        }, { timeout: 45000, intervals: [1000, 2000] }).toBe(true);
        const mail = mailpit('/message/' + messages()[0].ID);
        expect(mail.Subject).toBe(name); expect(mail.Text).toContain(order.orderNumber);
        expect(mail.Attachments.some(attachment => attachment.ContentType === 'application/pdf' && attachment.Size > 1000)).toBe(true);
        const sent = (await (await request.post('/api/search/document', { headers, data: { ids: [doc.id], limit: 1 } })).json()).data[0]; expect(sent.sent).toBe(true);
    } finally {
        const docs = (await (await request.post('/api/search/document', { headers, data: { limit: 50, filter: [{ type: 'equals', field: 'orderId', value: order.id }] } })).json()).data;
        for (const doc of docs) expect((await request.delete('/api/document/' + doc.id, { headers })).ok()).toBeTruthy();
        expect((await request.delete('/api/order/' + order.id, { headers })).ok()).toBeTruthy();
        if (templateCreated) expect((await request.delete('/api/mail-template/' + templateId, { headers })).ok()).toBeTruthy();
        const ids = messages().map(message => message.ID); if (ids.length) mailpit('/messages', 'DELETE', { IDs: ids });
    }
});

test('Theme-Kopie speichert Farben und stellt die Vererbung wieder her', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-THEME-${Date.now()}`; let id: string | undefined;
    const parent = (await (await request.post('/api/search/theme', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'technicalName', value: 'Storefront' }] } })).json()).data[0];
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await login(page); await page.evaluate(() => { location.hash = 'themes'; });
        const list = page.getByRole('dialog', { name: 'Themes', exact: true });
        await list.getByRole('button', { name: 'Theme-Kopie anlegen', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'Theme-Kopie anlegen', exact: true });
        await create.getByRole('textbox', { name: /^Name:/ }).fill(name);
        await chooseReference(page, create, 'Basis-Theme:', parent.name);
        const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/theme') && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(created.ok()).toBeTruthy(); id = created.request().postDataJSON().id;
        await expect(create).not.toBeVisible(); await list.getByRole('textbox', { name: 'Themes suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Theme-Kopie bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Theme-Konfiguration', exact: true }).click();
        const inherit = editor.getByRole('checkbox', { name: 'Vorgabe verwenden: Primärfarbe', exact: true });
        await expect(inherit).toBeChecked(); await inherit.uncheck();
        await editor.getByRole('textbox', { name: 'Primärfarbe:', exact: true }).fill('#123456');
        const save = async () => {
            const [response] = await Promise.all([page.waitForResponse(response => response.url().includes(`/api/_action/theme/${id}?`) && response.request().method() === 'PATCH'),
                editor.getByRole('button', { name: 'Theme-Konfiguration speichern', exact: true }).click()]);
            expect(response.ok(), (await response.json()).errors?.[0]?.detail).toBeTruthy();
        };
        await save();
        let read = await request.post('/api/search/theme', { headers, data: { ids: [id], limit: 1 } });
        expect((await read.json()).data[0].configValues['sw-color-brand-primary'].value).toBe('#123456');
        await expect(inherit).not.toBeChecked(); await inherit.check(); await save();
        read = await request.post('/api/search/theme', { headers, data: { ids: [id], limit: 1 } });
        expect((await read.json()).data[0].configValues?.['sw-color-brand-primary']).toBeUndefined();
        await expect(inherit).toBeChecked(); expect(errors).toEqual([]);
    } finally { if (id) expect((await request.delete(`/api/theme/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Textbausteine aus Basisdateien lassen sich überschreiben und zurücksetzen', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const setId = randomUUID().replaceAll('-', ''); const name = `EMZ-SNIPPETS-${Date.now()}`;
    const source = (await (await request.post('/api/search/snippet-set', { headers, data: { limit: 1 } })).json()).data[0];
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        expect((await request.post('/api/snippet-set', { headers, data: { id: setId, name, iso: source.iso, baseFile: source.baseFile } })).ok()).toBeTruthy();
        const all = (await (await request.post('/api/_action/snippet-set', { headers, data: { limit: 1, page: 1, filters: {}, sort: { sortBy: 'id', sortDirection: 'ASC' } } })).json()).data;
        const [key, entries] = Object.entries(all)[0] as [string, any[]]; const base = entries.find(item => item.setId === setId);
        expect(base.id).toBeNull();
        await login(page); await page.evaluate(() => { location.hash = 'snippets'; });
        const list = page.getByRole('dialog', { name: 'Textbausteine', exact: true });
        await chooseReference(page, list, 'Textbaustein-Set:', name);
        await list.getByRole('textbox', { name: 'Textbausteine suchen', exact: true }).fill(key);
        await list.getByRole('gridcell', { name: key, exact: true }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Textbaustein bearbeiten', exact: true });
        await editor.getByRole('textbox', { name: 'Text:', exact: true }).fill(name);
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(editor).not.toBeVisible();
        const filter = [{ type: 'equals', field: 'setId', value: setId }, { type: 'equals', field: 'translationKey', value: key }];
        const read = await request.post('/api/search/snippet', { headers, data: { limit: 1, filter } });
        expect((await read.json()).data[0].value).toBe(name);
        const row = list.getByRole('row').filter({ hasText: name }); await row.click();
        await list.getByRole('button', { name: 'Überschreibung entfernen', exact: true }).click();
        await page.getByRole('button', { name: 'Ja', exact: true }).click();
        await expect(row).not.toBeVisible();
        const reset = await request.post('/api/search/snippet', { headers, data: { limit: 1, filter } });
        expect((await reset.json()).data).toHaveLength(0);
        const merged = (await (await request.post('/api/_action/snippet-set', { headers, data: { limit: 25, filters: { term: key }, sort: {} } })).json()).data;
        expect(merged[key].find(item => item.setId === setId).value).toBe(base.value);
        expect(errors).toEqual([]);
    } finally { expect((await request.delete(`/api/snippet-set/${setId}`, { headers })).ok()).toBeTruthy(); }
});

test('Verkaufskanal-Zuordnungen speichern zusätzliche Länder und schützen den Standardwert', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const id = randomUUID().replaceAll('-', ''); const name = `EMZ-CHANNEL-${Date.now()}`;
    const source = (await (await request.post('/api/search/sales-channel', { headers, data: { limit: 1 } })).json()).data[0];
    const extra = (await (await request.post('/api/search/country', { headers, data: { limit: 1, filter: [{ type: 'not', operator: 'AND', queries: [{ type: 'equals', field: 'id', value: source.countryId }] }] } })).json()).data[0];
    const main = (await (await request.post('/api/search/country', { headers, data: { limit: 1, ids: [source.countryId] } })).json()).data[0];
    const fields = ['typeId', 'languageId', 'currencyId', 'customerGroupId', 'countryId', 'paymentMethodId', 'shippingMethodId', 'navigationCategoryId'];
    const accessKey = (await (await request.get('/api/_action/access-key/sales-channel', { headers })).json()).accessKey;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        expect((await request.post('/api/sales-channel', { headers, data: { ...Object.fromEntries(fields.map(key => [key, source[key]])), id, name, accessKey, active: false, countries: [{ id: source.countryId }], currencies: [{ id: source.currencyId }], languages: [{ id: source.languageId }] } })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'sales-channels'; });
        const list = page.getByRole('dialog', { name: 'Verkaufskanäle', exact: true });
        await list.getByRole('textbox', { name: 'Verkaufskanäle suchen', exact: true }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Verkaufskanal bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Länder', exact: true }).click();
        await editor.getByRole('button', { name: 'Zuordnen', exact: true }).click();
        const assign = page.getByRole('dialog', { name: 'Länder zuordnen', exact: true });
        await chooseReference(page, assign, 'Länder:', extra.name);
        await assign.getByRole('button', { name: 'Zuordnen', exact: true }).click(); await expect(assign).not.toBeVisible();
        await expect(editor.getByRole('row').filter({ hasText: extra.name })).toBeVisible();
        await editor.getByRole('gridcell', { name: main.name, exact: true }).click();
        await editor.getByRole('button', { name: 'Zuordnung entfernen', exact: true }).click();
        await page.getByRole('button', { name: 'Ja', exact: true }).click();
        const error = page.getByRole('alertdialog', { name: 'Aktion nicht möglich', exact: true });
        await expect(page.getByText('Der Standardwert kann nicht entfernt werden. Bitte zunächst einen anderen Standardwert speichern.', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'OK', exact: true }).click();
        await editor.getByRole('gridcell', { name: extra.name, exact: true }).click();
        await editor.getByRole('button', { name: 'Zuordnung entfernen', exact: true }).click();
        await page.getByRole('button', { name: 'Ja', exact: true }).click();
        await expect(editor.getByRole('gridcell', { name: extra.name, exact: true })).not.toBeVisible();
        const read = await request.post('/api/search/sales-channel', { headers, data: { ids: [id], limit: 1, associations: { countries: {} } } });
        expect((await read.json()).data[0].countries.map(country => country.id)).toEqual([main.id]);
        expect(errors).toEqual([]);
    } finally { expect((await request.delete(`/api/sales-channel/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Aktion erhält Verkaufskanal, Rabatt, Regelzuordnung und individuell erzeugte Codes', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-PROMO-${Date.now()}`;
    const ruleId = randomUUID().replaceAll('-', ''); let promotionId: string | undefined;
    const channel = (await (await request.post('/api/search/sales-channel', { headers, data: { limit: 1 } })).json()).data[0];
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        expect((await request.post('/api/rule', { headers, data: { id: ruleId, name, priority: 1 } })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'promotions'; });
        const list = page.getByRole('dialog', { name: 'Rabatte & Aktionen', exact: true });
        await list.getByRole('button', { name: 'Aktion anlegen', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'Aktion anlegen', exact: true });
        await create.getByRole('textbox', { name: /^Name:/ }).fill(name);
        await create.getByRole('checkbox', { name: 'Aktionscode verwenden:', exact: true }).check();
        await create.getByRole('checkbox', { name: 'Individuelle Codes verwenden:', exact: true }).check();
        await create.getByRole('textbox', { name: 'Muster individueller Codes:', exact: true }).fill(`${name}-%s%s%s%s%d%d`);
        const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/promotion') && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(created.ok()).toBeTruthy(); promotionId = created.request().postDataJSON().id;
        await expect(create).not.toBeVisible();
        await list.getByRole('textbox', { name: 'Rabatte & Aktionen suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Aktion bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Verkaufskanäle', exact: true }).click();
        await editor.getByRole('button', { name: 'Kanalzuordnung anlegen', exact: true }).click();
        const channelDialog = page.getByRole('dialog', { name: 'Kanalzuordnung anlegen', exact: true });
        await chooseReference(page, channelDialog, 'Verkaufskanal:', channel.name);
        await channelDialog.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(channelDialog).not.toBeVisible();
        await editor.getByRole('tab', { name: 'Rabatte', exact: true }).click();
        await editor.getByRole('button', { name: 'Aktionsrabatt anlegen', exact: true }).click();
        const discount = page.getByRole('dialog', { name: 'Aktionsrabatt anlegen', exact: true });
        await discount.getByRole('spinbutton', { name: 'Wert:', exact: true }).fill('10');
        await discount.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(discount).not.toBeVisible();
        await editor.getByRole('tab', { name: 'Warenkorbregeln', exact: true }).click();
        await editor.getByRole('button', { name: 'Zuordnen', exact: true }).click();
        const relation = page.getByRole('dialog', { name: 'Warenkorbregeln zuordnen', exact: true });
        await chooseReference(page, relation, 'Warenkorbregeln:', name);
        await relation.getByRole('button', { name: 'Zuordnen', exact: true }).click(); await expect(relation).not.toBeVisible();
        await expect(editor.getByRole('row').filter({ hasText: name })).toBeVisible();
        await editor.getByRole('row').filter({ hasText: name }).click();
        await editor.getByRole('button', { name: 'Zuordnung entfernen', exact: true }).click();
        await page.getByRole('button', { name: 'Ja', exact: true }).click();
        await expect(editor.getByRole('row').filter({ hasText: name })).not.toBeVisible();
        await editor.getByRole('tab', { name: 'Individuelle Codes', exact: true }).click();
        await editor.getByRole('button', { name: 'Codes erzeugen', exact: true }).click();
        const codes = page.getByRole('dialog', { name: 'Individuelle Codes erzeugen', exact: true });
        await codes.getByRole('spinbutton', { name: 'Anzahl neuer Codes:', exact: true }).fill('3');
        await codes.getByRole('button', { name: 'Codes hinzufügen', exact: true }).click(); await expect(codes).not.toBeVisible();
        const read = await request.post('/api/search/promotion', { headers, data: { ids: [promotionId], limit: 1, associations: { salesChannels: {}, discounts: {}, individualCodes: {}, cartRules: {} } } });
        const promotion = (await read.json()).data[0];
        expect(promotion.active).toBeFalsy(); expect(promotion.salesChannels[0].salesChannelId).toBe(channel.id);
        expect(promotion.discounts[0].value).toBe(10); expect(promotion.cartRules).toHaveLength(0);
        expect(promotion.individualCodes).toHaveLength(3); expect(new Set(promotion.individualCodes.map(code => code.code)).size).toBe(3);
        expect(errors).toEqual([]);
    } finally {
        if (promotionId) expect((await request.delete(`/api/promotion/${promotionId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/rule/${ruleId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Dynamische Produktgruppe speichert Filter und zeigt passende Produkte in der Vorschau', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-STREAM-${Date.now()}`;
    const streamId = randomUUID().replaceAll('-', ''); const productId = randomUUID().replaceAll('-', '');
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page);
    const currencyId = await page.locator('#emz-admin-config').getAttribute('data-currency-id');
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
    try {
        expect((await request.post('/api/product', { headers, data: { id: productId, name, productNumber: name, stock: 5, taxId: tax.id, price: [{ currencyId, gross: 10, net: 10, linked: false }] } })).ok()).toBeTruthy();
        expect((await request.post('/api/product-stream', { headers, data: { id: streamId, name, displayAsGroup: true } })).ok()).toBeTruthy();
        await page.evaluate(() => { location.hash = 'product-streams'; });
        const list = page.getByRole('dialog', { name: 'Dynamische Produktgruppen', exact: true });
        await list.getByRole('textbox', { name: 'Dynamische Produktgruppen suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Produktgruppe bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Produktfilter', exact: true }).click();
        await expect(editor.getByRole('row').filter({ hasText: 'UND' })).toBeVisible();
        await editor.getByRole('button', { name: 'Filter hinzufügen', exact: true }).click();
        const filter = page.getByRole('dialog', { name: 'Produktfilter bearbeiten', exact: true });
        await filter.getByRole('textbox', { name: 'Wert:', exact: true }).fill(name);
        await filter.getByRole('button', { name: 'Übernehmen', exact: true }).click();
        await editor.getByRole('button', { name: 'Filter hinzufügen', exact: true }).click();
        await filter.getByRole('combobox', { name: 'Produktfeld:', exact: true }).fill('Bestand');
        await page.getByRole('option', { name: 'Bestand', exact: true }).click();
        await filter.getByRole('combobox', { name: 'Vergleich:', exact: true }).click();
        await page.getByRole('option', { name: 'Wertebereich', exact: true }).click();
        await filter.getByRole('spinbutton', { name: 'Von (einschließlich):', exact: true }).fill('1');
        await filter.getByRole('spinbutton', { name: 'Bis (einschließlich):', exact: true }).fill('10');
        await filter.getByRole('button', { name: 'Übernehmen', exact: true }).click();
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/sync') && response.request().method() === 'POST'),
            editor.getByRole('button', { name: 'Filter speichern', exact: true }).click()]);
        expect(saved.ok()).toBeTruthy();
        await editor.getByRole('button', { name: 'Vorschau', exact: true }).click();
        const preview = page.getByRole('dialog', { name: 'Produktgruppen-Vorschau', exact: true });
        await expect(preview.getByRole('row').filter({ hasText: name })).toBeVisible();
        await expect(preview.getByText('1 Produkte · Seite 1', { exact: true })).toBeVisible();
        const response = await request.post('/api/search/product-stream', { headers, data: { ids: [streamId], limit: 1 } });
        const stream = (await response.json()).data[0];
        expect(stream.invalid).toBeFalsy(); expect(stream.apiFilter[0].queries).toHaveLength(2);
        expect(errors).toEqual([]);
    } finally {
        expect((await request.delete(`/api/product-stream/${streamId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/product/${productId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Import/Export verarbeitet CSV-Probelauf, Import und Export über den Admin-Worker', async ({ page, request }) => {
    test.setTimeout(150000);
    const headers = await integrationHeaders(request);
    const fixtureId = randomUUID().replaceAll('-', ''); const name = `EMZ-CSV-${Date.now()}`;
    let profileId: string | undefined;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const csv = `id;name;active;type\n${fixtureId};${name};0;page\n`;
    try {
        await login(page); await page.evaluate(() => { location.hash = 'import-export'; });
        const module = page.getByRole('dialog', { name: 'Import / Export', exact: true });
        await module.getByRole('tab', { name: 'Profile', exact: true }).click();
        await module.getByRole('button', { name: 'Profil anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Profil anlegen', exact: true });
        await editor.getByRole('textbox', { name: /^Name:/ }).fill(name);
        await editor.getByRole('textbox', { name: 'Technischer Name:', exact: true }).fill(name);
        await editor.getByRole('combobox', { name: 'Objekt:', exact: true }).click();
        await page.getByRole('option', { name: 'category', exact: true }).click();
        const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/import-export-profile') && response.request().method() === 'POST'),
            editor.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(created.ok(), (await created.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        profileId = created.request().postDataJSON().id;
        await expect(editor).not.toBeVisible();
        await module.getByRole('textbox', { name: 'Import-/Exportprofile suchen' }).fill(name);
        await module.getByRole('row').filter({ hasText: name }).dblclick();
        const edit = page.getByRole('dialog', { name: 'Profil bearbeiten', exact: true });
        await edit.getByRole('tab', { name: 'Feldzuordnung', exact: true }).click();
        await edit.getByRole('button', { name: 'Aus CSV übernehmen', exact: true }).click();
        const mapping = page.getByRole('dialog', { name: 'Feldzuordnung aus CSV', exact: true });
        await mapping.locator('input[type=file]').setInputFiles({ name: 'fields.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await mapping.getByRole('button', { name: 'Zuordnung übernehmen', exact: true }).click();
        await expect(mapping).not.toBeVisible();
        const [mappingSaved] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/import-export-profile/${profileId}`) && response.request().method() === 'PATCH'),
            edit.getByRole('button', { name: 'Zuordnung speichern', exact: true }).click()]);
        expect(mappingSaved.ok()).toBeTruthy();
        await edit.getByRole('button', { name: 'Abbrechen', exact: true }).click();
        const run = async (activity: string) => {
            await module.getByRole('tab', { name: 'Import / Export starten', exact: true }).click();
            const form = module.getByRole('tabpanel', { name: 'Import / Export starten', exact: true });
            if (await form.getByRole('combobox', { name: 'Profil:', exact: true }).inputValue() !== name) await chooseReference(page, form, 'Profil:', name);
            await form.getByRole('combobox', { name: 'Vorgang:', exact: true }).click();
            await page.getByRole('option', { name: activity, exact: true }).click();
            if (activity !== 'Export') await form.locator('input[type=file]').setInputFiles({ name: 'fixture.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
            if (activity === 'Import') await form.getByRole('checkbox').check();
            const [prepared] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/import-export/prepare') && response.request().method() === 'POST'),
                form.getByRole('button', { name: 'Vorgang starten', exact: true }).click()]);
            expect(prepared.ok(), (await prepared.json()).errors?.[0]?.detail).toBeTruthy();
            const logId = (await prepared.json()).log.id;
            await expect.poll(async () => {
                const response = await request.post('/api/search/import-export-log', { headers, data: { ids: [logId], limit: 1 } });
                const log = (await response.json()).data[0];
                if (log.state === 'failed') throw new Error(`CSV-Auftrag fehlgeschlagen: ${JSON.stringify(log.result)}`);
                return log.state;
            }, { timeout: 55000, intervals: [1000] }).toBe('succeeded');
        };
        await run('Import-Probelauf');
        const probe = await request.post('/api/search/category', { headers, data: { ids: [fixtureId], limit: 1 } });
        expect((await probe.json()).data).toHaveLength(0);
        await run('Import');
        const imported = await request.post('/api/search/category', { headers, data: { ids: [fixtureId], limit: 1 } });
        expect((await imported.json()).data[0].name).toBe(name);
        await run('Export');
        await module.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
        const row = module.getByRole('tabpanel', { name: 'Verlauf', exact: true }).getByRole('row').filter({ hasText: name }).filter({ hasText: 'Export' }).first();
        await expect(row).toContainText('Abgeschlossen'); await row.click();
        const [file] = await Promise.all([page.waitForEvent('download'), module.getByRole('button', { name: 'Datei herunterladen', exact: true }).click()]);
        expect(await readFile((await file.path())!, 'utf8')).toContain(name);
        expect(errors).toEqual([]);
    } finally {
        if (profileId) {
            const response = await request.post('/api/search/import-export-log', { headers, data: { limit: 50, filter: [{ type: 'equals', field: 'profileId', value: profileId }] } });
            for (const log of (await response.json()).data || []) {
                if (['progress', 'merging_files'].includes(log.state)) await request.post('/api/_action/import-export/cancel', { headers, data: { logId: log.id } });
                if (log.fileId) expect((await request.delete(`/api/import-export-file/${log.fileId}`, { headers })).ok()).toBeTruthy();
            }
            expect((await request.delete(`/api/import-export-profile/${profileId}`, { headers })).ok()).toBeTruthy();
        }
        const lookup = await request.post('/api/search/category', { headers, data: { ids: [fixtureId], limit: 1 } });
        if ((await lookup.json()).data.length) expect((await request.delete(`/api/category/${fixtureId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Varianten erzeugen und Währungs- und Staffelpreise dauerhaft speichern', async ({ page, request }) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const headers = await integrationHeaders(request);
    const id = () => randomUUID().replaceAll('-', '');
    const productId = id(); const groupId = id(); const ruleId = id();
    const options = [id(), id()]; const number = `EMZ-VARIANT-${Date.now()}`;
    await login(page);
    const currencyId = await page.locator('#emz-admin-config').getAttribute('data-currency-id');
    const taxes = await request.post('/api/search/tax', { headers, data: { limit: 1 } });
    const tax = (await taxes.json()).data[0];
    try {
        expect((await request.post('/api/property-group', { headers, data: { id: groupId, name: number, displayType: 'text', sortingType: 'alphanumeric',
            options: options.map((optionId, index) => ({ id: optionId, name: `Option ${index + 1}` })) } })).ok()).toBeTruthy();
        expect((await request.post('/api/rule', { headers, data: { id: ruleId, name: number, priority: 1 } })).ok()).toBeTruthy();
        expect((await request.post('/api/product', { headers, data: { id: productId, name: number, productNumber: number, stock: 1, taxId: tax.id,
            price: [{ currencyId, gross: 119, net: 100, linked: false }], configuratorSettings: options.map(optionId => ({ optionId })) } })).ok()).toBeTruthy();
        await page.getByRole('button', { name: 'Artikel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Produkte', exact: true }).click();
        await page.getByRole('textbox', { name: 'Produkte suchen' }).fill(number);
        await page.getByRole('dialog', { name: 'Produkte', exact: true }).getByRole('row').filter({ hasText: number }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Varianten', exact: true }).click();
        await editor.getByRole('button', { name: 'Varianten erzeugen', exact: true }).click();
        const generator = page.getByRole('dialog', { name: 'Varianten erzeugen', exact: true });
        await expect(generator.getByText('2 neue Kombinationen.', { exact: false })).toBeVisible();
        const generated = page.waitForResponse(response => response.url().endsWith('/api/_action/sync') && response.request().method() === 'POST');
        await generator.getByRole('button', { name: 'Ausgewählte Varianten erzeugen' }).click();
        expect((await generated).ok()).toBeTruthy();
        await expect(generator).not.toBeVisible();
        const variants = await request.post('/api/search/product', { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'parentId', value: productId }], associations: { options: {} } } });
        const children = (await variants.json()).data;
        expect(children).toHaveLength(2); expect(children.every(child => child.stock === 0 && child.options.length === 1)).toBeTruthy();
        await editor.getByRole('button', { name: 'Varianten erzeugen', exact: true }).click();
        await expect(generator.getByText('0 neue Kombinationen.', { exact: false })).toBeVisible();
        await expect(generator.getByRole('button', { name: 'Ausgewählte Varianten erzeugen' })).toBeDisabled();
        await generator.getByRole('button', { name: 'Abbrechen', exact: true }).click();

        await editor.getByRole('tab', { name: 'Währungspreise', exact: true }).click();
        await editor.getByRole('gridcell').filter({ hasText: /^119$/ }).dblclick();
        const priceDialog = page.getByRole('dialog', { name: 'Währungspreis bearbeiten', exact: true });
        await priceDialog.getByRole('spinbutton', { name: 'Brutto:', exact: true }).fill('130');
        await priceDialog.getByRole('spinbutton', { name: 'Streichpreis brutto' }).fill('180');
        await priceDialog.getByRole('spinbutton', { name: 'Streichpreis netto' }).fill('150');
        await priceDialog.getByRole('button', { name: 'Preis speichern' }).click();
        await expect(priceDialog).not.toBeVisible();
        const updated = await request.post('/api/search/product', { headers, data: { ids: [productId], limit: 1 } });
        const price = (await updated.json()).data[0].price.find(item => item.currencyId === currencyId);
        expect(price.gross).toBe(130); expect(price.listPrice.gross).toBe(180);

        await editor.getByRole('tab', { name: 'Erweiterte Preise', exact: true }).click();
        await editor.getByRole('button', { name: 'Preisstaffel anlegen', exact: true }).click();
        const tier = page.getByRole('dialog', { name: 'Preisstaffel anlegen', exact: true });
        await chooseReference(page, tier, 'Regel', number);
        await tier.getByRole('spinbutton', { name: 'Brutto (' }).fill('99');
        await tier.getByRole('spinbutton', { name: 'Netto (' }).fill('80');
        await tier.getByRole('button', { name: 'Speichern', exact: true }).click();
        await expect(tier).not.toBeVisible();
        const tiers = await request.post('/api/search/product-price', { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'productId', value: productId }] } });
        const savedTiers = (await tiers.json()).data;
        expect(savedTiers).toHaveLength(1); expect(savedTiers[0].quantityStart).toBe(1); expect(savedTiers[0].price[0].gross).toBe(99);
        expect(errors).toEqual([]);
    } finally {
        expect((await request.delete(`/api/product/${productId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/property-group/${groupId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/rule/${ruleId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Produktübersetzungen, Zusatzfelder und private Download-Dateien funktionieren', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request);
    const id = () => randomUUID().replaceAll('-', '');
    const productId = id(); const languageId = id(); const setId = id(); const fieldId = id(); const preservedFieldId = id();
    const number = `EMZ-CONTENT-${Date.now()}`; const fieldName = `emz_test_${fieldId}`; const preservedField = `emz_test_${preservedFieldId}`;
    let mediaId: string | undefined;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page);
    const currencyId = await page.locator('#emz-admin-config').getAttribute('data-currency-id');
    const parentId = await page.locator('#emz-admin-config').getAttribute('data-language-id');
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
    const locale = (await (await request.post('/api/search/locale', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'code', value: 'en-GB' }] } })).json()).data[0];
    try {
        expect((await request.post('/api/language', { headers, data: { id: languageId, name: number, parentId, localeId: locale.id, translationCodeId: locale.id } })).ok()).toBeTruthy();
        expect((await request.post('/api/custom-field-set', { headers, data: { id: setId, name: number.replaceAll('-', '_'), active: true, global: true,
            config: { label: { 'de-DE': 'Test-Zusatzfelder' } }, relations: [{ entityName: 'product' }],
            customFields: [{ id: fieldId, name: fieldName, type: 'text', active: true, config: { label: { 'de-DE': 'Test-Wert' }, componentName: 'sw-text-field' } },
                { id: preservedFieldId, name: preservedField, type: 'text', active: true, config: { label: { 'de-DE': 'Unverändert' } } }] } })).ok()).toBeTruthy();
        expect((await request.post('/api/product', { headers, data: { id: productId, name: number, productNumber: number, stock: 1, taxId: tax.id, type: 'digital',
            price: [{ currencyId, gross: 10, net: 10, linked: false }], customFields: { [preservedField]: 'Behalten' } } })).ok()).toBeTruthy();
        await page.getByRole('button', { name: 'Artikel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Produkte', exact: true }).click();
        await page.getByRole('textbox', { name: 'Produkte suchen' }).fill(number);
        await page.getByRole('dialog', { name: 'Produkte', exact: true }).getByRole('row').filter({ hasText: number }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Übersetzungen', exact: true }).click();
        const translation = editor.getByRole('tabpanel', { name: 'Übersetzungen', exact: true });
        await chooseReference(page, translation, 'Sprache', number);
        const loaded = page.waitForResponse(response => response.url().endsWith('/api/search/product') && response.request().headers()['sw-language-id'] === languageId);
        await translation.getByRole('button', { name: 'Übersetzung laden', exact: true }).click();
        expect((await loaded).ok()).toBeTruthy();
        await translation.getByRole('textbox', { name: 'Produktname' }).fill('Translated product');
        const saved = page.waitForResponse(response => response.url().endsWith(`/api/product/${productId}`) && response.request().method() === 'PATCH');
        await translation.getByRole('button', { name: 'Übersetzung speichern' }).click();
        expect((await saved).ok()).toBeTruthy();
        const translated = await request.post('/api/search/product', { headers: { ...headers, 'sw-language-id': languageId }, data: { ids: [productId], limit: 1 } });
        expect((await translated.json()).data[0].name).toBe('Translated product');

        await editor.getByRole('tab', { name: 'Zusatzfelder', exact: true }).click();
        const custom = editor.getByRole('tabpanel', { name: 'Zusatzfelder', exact: true });
        await custom.getByRole('textbox', { name: 'Test-Wert' }).fill('Eigener Wert');
        const customSaved = page.waitForResponse(response => response.url().endsWith(`/api/product/${productId}`) && response.request().method() === 'PATCH');
        await custom.getByRole('button', { name: 'Zusatzfelder speichern' }).click();
        expect((await customSaved).ok()).toBeTruthy();
        const original = (await (await request.post('/api/search/product', { headers, data: { ids: [productId], limit: 1 } })).json()).data[0];
        expect(original.name).toBe(number);
        expect(original.customFields[fieldName]).toBe('Eigener Wert'); expect(original.customFields[preservedField]).toBe('Behalten');

        await editor.getByRole('tab', { name: 'Downloads', exact: true }).click();
        await editor.getByRole('button', { name: 'Download-Datei hochladen' }).click();
        const upload = page.getByRole('dialog', { name: 'Datei hochladen', exact: true });
        await upload.locator('input[type="file"]').setInputFiles({ name: `${number}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Geschützter Testdownload') });
        await upload.getByRole('button', { name: 'Hochladen', exact: true }).click();
        await expect(upload).not.toBeVisible();
        const downloads = (await (await request.post('/api/search/product-download', { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'productId', value: productId }], associations: { media: {} } } })).json()).data;
        expect(downloads).toHaveLength(1); mediaId = downloads[0].mediaId;
        expect(downloads[0].media.private).toBe(true);
        await editor.getByRole('row').filter({ hasText: number }).click();
        const downloadPromise = page.waitForEvent('download');
        await editor.getByRole('button', { name: 'Datei herunterladen' }).click();
        const download = await downloadPromise;
        expect(await readFile((await download.path())!, 'utf8')).toBe('Geschützter Testdownload');
        expect(errors).toEqual([]);
    } finally {
        if (!mediaId) {
            const found = await request.post('/api/search/media', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'fileName', value: number }] } });
            mediaId = (await found.json()).data[0]?.id;
        }
        expect((await request.delete(`/api/product/${productId}`, { headers })).ok()).toBeTruthy();
        if (mediaId) expect((await request.delete(`/api/media/${mediaId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/custom-field-set/${setId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/language/${languageId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Login, Produkt anlegen und ändern, Refresh und Logout im echten Shop', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    const tokenResponse = await request.post('/api/oauth/token', {
        data: { client_id: 'administration', grant_type: 'password', scope: 'write', username, password },
    });
    expect(tokenResponse.ok()).toBeTruthy();
    const token = (await tokenResponse.json()).access_token;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const number = `EMZ-MVP-TEST-${Date.now()}`;
    let productId: string | undefined;
    try {
        await login(page);
        await expect(page.locator('.emz-admin__metric strong')).toHaveCount(6);
        const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true });
        await dashboard.getByRole('button', { name: 'Minimieren', exact: true }).click();
        await expect(dashboard).not.toBeVisible();
        await page.getByRole('toolbar', { name: 'Geöffnete Fenster' }).getByRole('button', { name: /Dashboard/ }).click();
        await expect(dashboard).toBeVisible();
        const initialSize = await dashboard.boundingBox();
        await dashboard.getByRole('button', { name: 'Maximieren', exact: true }).click();
        await expect(dashboard).toHaveClass(/x-window-maximized/);
        await dashboard.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
        expect((await dashboard.boundingBox())!.width).toBe(initialSize!.width);
        await dashboard.getByRole('button', { name: 'Schließen', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(dashboard).not.toBeVisible();
        await page.getByRole('toolbar', { name: 'Hauptmenü' }).getByRole('button', { name: 'Dashboard', exact: true }).click();
        await expect(dashboard).toBeVisible();
        await page.screenshot({ path: 'test-results/ext-administration-dashboard.png', fullPage: true });
        await page.getByRole('button', { name: 'Artikel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Produkte', exact: true }).click();
        await page.getByRole('button', { name: 'Produkt anlegen', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Produkt anlegen' });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('textbox', { name: 'Produktname' }).fill('MVP Browsertest <b>Text</b>');
        await dialog.getByRole('textbox', { name: 'Artikelnummer' }).fill(number);
        await dialog.getByRole('spinbutton', { name: 'Lagerbestand' }).fill('12');
        await dialog.getByRole('spinbutton', { name: 'Bruttopreis' }).fill('119');
        await dialog.getByRole('spinbutton', { name: 'Bruttopreis' }).press('Tab');
        const created = page.waitForResponse(response => response.url().endsWith('/api/product') && response.request().method() === 'POST');
        await dialog.getByRole('button', { name: 'Speichern' }).click();
        expect((await created).ok()).toBeTruthy();
        await expect(dialog).not.toBeVisible();
        const search = await request.post('/api/search/product', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'productNumber', value: number }] } });
        const product = (await search.json()).data[0];
        productId = product.id;
        expect(product.stock).toBe(12);
        expect(product.price[0].gross).toBe(119);
        await page.getByRole('textbox', { name: 'Produkte suchen' }).fill(number);
        const row = page.getByRole('dialog', { name: 'Produkte', exact: true }).getByRole('row').filter({ hasText: number });
        await expect(row).toBeVisible();
        await expect(row.locator('b')).toHaveCount(0);
        await row.dblclick();
        const edit = page.getByRole('dialog', { name: 'Produkt bearbeiten' });
        await edit.getByRole('spinbutton', { name: 'Lagerbestand' }).fill('17');
        const updated = page.waitForResponse(response => response.url().endsWith(`/api/product/${productId}`) && response.request().method() === 'PATCH');
        await edit.getByRole('button', { name: 'Speichern' }).click();
        const updateResponse = await updated;
        expect(updateResponse.ok()).toBeTruthy();
        expect(updateResponse.request().postDataJSON()).toEqual({ stock: 17 });
        await expect(edit).not.toBeVisible();
        await expect(row).toContainText('17');
        await page.evaluate(() => {
            const key = Object.keys(sessionStorage).find(key => key.startsWith('emz.ext-admin.session:'))!;
            const session = JSON.parse(sessionStorage.getItem(key)!);
            session.expiresAt = 0;
            sessionStorage.setItem(key, JSON.stringify(session));
        });
        const refreshed = page.waitForResponse(response => response.url().endsWith('/api/oauth/token'));
        await page.reload();
        expect((await refreshed).ok()).toBeTruthy();
        await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
        await page.screenshot({ path: 'test-results/ext-administration-products.png', fullPage: true });
        await page.getByRole('button', { name: 'Abmelden' }).click();
        await expect(page.getByRole('textbox', { name: 'Benutzername' })).toBeVisible();
        await expect(page.locator('.emz-admin__module-window')).toHaveCount(0);
        expect(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('emz.ext-admin.session:')))).toBeFalsy();
        expect(errors).toEqual([]);
    } finally {
        // Logout invalidates all user tokens; get a fresh token solely for test-data cleanup.
        const auth = await request.post('/api/oauth/token', { data: { client_id: 'administration', grant_type: 'password', scope: 'write', username, password } });
        const cleanupHeaders = { Authorization: `Bearer ${(await auth.json()).access_token}`, Accept: 'application/json' };
        if (!productId) {
            const search = await request.post('/api/search/product', { headers: cleanupHeaders, data: { limit: 1, filter: [{ type: 'equals', field: 'productNumber', value: number }] } });
            productId = (await search.json()).data?.[0]?.id;
        }
        if (productId) expect((await request.delete(`/api/product/${productId}`, { headers: cleanupHeaders })).ok()).toBeTruthy();
    }
});

test('Fehlerhafte Anmeldung zeigt eine verständliche Meldung', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('textbox', { name: 'Benutzername' }).fill('emz-nonexistent-test-user');
    await page.getByLabel('Passwort', { exact: false }).fill('invalid-test-password');
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByText('Benutzername oder Passwort ist ungültig.')).toBeVisible();
    await expect(page.getByLabel('Passwort', { exact: false })).toHaveValue('');
});

test('Shopware-Oberfläche bleibt über den Fallback erreichbar', async ({ page }) => {
    await page.goto('/admin?native=1');
    await expect(page.locator('#app')).toBeAttached();
    await expect(page.locator('#emz-admin-config')).toHaveCount(0);
});

test('Echte Leserolle kann Produkte ansehen und keine Produkte schreiben', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const roleId = randomUUID().replaceAll('-', '');
    const userId = randomUUID().replaceAll('-', '');
    const forbiddenProductId = randomUUID().replaceAll('-', '');
    const credentials = { username: `emz-mvp-reader-${userId}`, password: randomUUID() };
    let roleCreated = false;
    let userCreated = false;
    let unexpectedProductCreated = false;
    try {
        const locales = await request.post('/api/search/locale', { headers, data: { limit: 1 } });
        const role = await request.post('/api/acl-role', { headers, data: {
            id: roleId, name: `MVP Test ${roleId}`, privileges: ['product:read', 'tax:read'],
        } });
        expect(role.ok()).toBeTruthy();
        roleCreated = true;
        const user = await request.post('/api/user', { headers, data: {
            id: userId, ...credentials, firstName: 'Test', lastName: 'Leserolle', email: `${credentials.username}@example.invalid`,
            localeId: (await locales.json()).data[0].id, active: true, admin: false, aclRoles: [{ id: roleId }],
        } });
        expect(user.ok()).toBeTruthy();
        userCreated = true;
        await login(page, credentials);
        await page.getByRole('button', { name: 'Artikel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Produkte', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Produkt anlegen', exact: true })).toBeDisabled();
        await page.getByRole('dialog', { name: 'Produkte', exact: true }).getByRole('gridcell').first().dblclick();
        const dialog = page.getByRole('dialog', { name: 'Produkt bearbeiten' });
        await expect(dialog.getByRole('button', { name: 'Speichern' })).toBeDisabled();
        await expect(dialog.getByRole('textbox', { name: 'Produktname' })).not.toBeEditable();
        await dialog.getByRole('button', { name: 'Abbrechen' }).click();
        await page.evaluate(() => { location.hash = 'taxes'; });
        const taxList = page.getByRole('dialog', { name: 'Steuersätze', exact: true });
        await expect(taxList.getByRole('button', { name: 'Steuersatz anlegen', exact: true })).toBeDisabled();
        await taxList.getByRole('gridcell').first().dblclick();
        const taxEditor = page.getByRole('dialog', { name: 'Steuersatz bearbeiten', exact: true });
        await expect(taxEditor.getByRole('button', { name: 'Speichern', exact: true })).toBeDisabled();
        await expect(taxEditor.getByRole('spinbutton', { name: 'Steuersatz (%)', exact: false })).not.toBeEditable();
        await taxEditor.getByRole('button', { name: 'Abbrechen' }).click();
        const denied = await page.evaluate(async id => {
            const key = Object.keys(sessionStorage).find(key => key.startsWith('emz.ext-admin.session:'))!;
            const token = JSON.parse(sessionStorage.getItem(key)!).access_token;
            const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
            const taxes = await fetch('/api/search/tax', { method: 'POST', headers, body: JSON.stringify({limit: 1}) });
            const response = await fetch('/api/product', { method: 'POST', headers, body: JSON.stringify({
                id, name: 'MVP ACL Test', productNumber: `EMZ-MVP-ACL-${id}`, stock: 0, active: false,
                taxId: (await taxes.json()).data[0].id,
                price: [{ currencyId: document.getElementById('emz-admin-config')!.dataset.currencyId, gross: 0, net: 0, linked: true }],
            }) });
            return response.status;
        }, forbiddenProductId);
        const defaultQueuePermission = await page.evaluate(async () => {
            const key = Object.keys(sessionStorage).find(key => key.startsWith('emz.ext-admin.session:'))!;
            const token = JSON.parse(sessionStorage.getItem(key)!).access_token;
            const result = await fetch('/api/_action/emz-ext-admin/message-queue/consume', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ receiver: 'async' }) });
            return result.status;
        });
        expect(defaultQueuePermission).toBe(200);
        unexpectedProductCreated = denied >= 200 && denied < 300;
        expect(denied).toBe(403);
    } finally {
        if (unexpectedProductCreated) expect((await request.delete(`/api/product/${forbiddenProductId}`, { headers })).ok()).toBeTruthy();
        if (userCreated) expect((await request.delete(`/api/user/${userId}`, { headers })).ok()).toBeTruthy();
        if (roleCreated) expect((await request.delete(`/api/acl-role/${roleId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Hersteller anlegen, suchen, gezielt ändern und löschen', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const name = `EMZ-ADMIN-MANUFACTURER-${Date.now()}`;
    let id: string | undefined;
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'manufacturers'; });
        const listing = page.getByRole('dialog', { name: 'Hersteller', exact: true });
        await listing.getByRole('button', { name: 'Hersteller anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Hersteller anlegen', exact: true });
        await editor.getByRole('textbox', { name: 'Name', exact: false }).fill(name);
        await editor.getByRole('textbox', { name: 'Website', exact: false }).fill('https://example.invalid/');
        const create = page.waitForResponse(response => response.url().endsWith('/api/product-manufacturer') && response.request().method() === 'POST');
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        expect((await create).ok()).toBeTruthy();
        await expect(editor).not.toBeVisible();
        const search = await request.post('/api/search/product-manufacturer', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
        id = (await search.json()).data[0].id;
        await listing.getByRole('textbox', { name: 'Hersteller suchen' }).fill(name);
        await listing.getByRole('row').filter({ hasText: name }).dblclick();
        const edit = page.getByRole('dialog', { name: 'Hersteller bearbeiten', exact: true });
        await edit.getByRole('textbox', { name: 'Name', exact: false }).fill(`${name}-updated`);
        const update = page.waitForResponse(response => response.url().endsWith(`/api/product-manufacturer/${id}`) && response.request().method() === 'PATCH');
        await edit.getByRole('button', { name: 'Speichern', exact: true }).click();
        const response = await update;
        expect(response.ok()).toBeTruthy();
        expect(response.request().postDataJSON()).toEqual({ name: `${name}-updated` });
        await expect(edit).not.toBeVisible();
        await listing.getByRole('row').filter({ hasText: `${name}-updated` }).click();
        await listing.getByRole('button', { name: 'Löschen', exact: true }).click();
        const confirmation = page.getByRole('alertdialog');
        const deleted = page.waitForResponse(response => response.url().endsWith(`/api/product-manufacturer/${id}`) && response.request().method() === 'DELETE');
        await confirmation.getByRole('button', { name: /Ja|Yes/ }).click();
        expect((await deleted).ok()).toBeTruthy();
        id = undefined;
        await expect(listing.getByRole('row').filter({ hasText: name })).toHaveCount(0);
    } finally {
        if (!id) {
            const search = await request.post('/api/search/product-manufacturer', { headers, data: { limit: 1, filter: [{ type: 'contains', field: 'name', value: name }] } });
            id = (await search.json()).data?.[0]?.id;
        }
        if (id) expect((await request.delete(`/api/product-manufacturer/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Steuersatz mit numerischen Werten anlegen und bearbeiten', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const name = `EMZ-ADMIN-TAX-${Date.now()}`;
    let id: string | undefined;
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'taxes'; });
        const listing = page.getByRole('dialog', { name: 'Steuersätze', exact: true });
        await listing.getByRole('button', { name: 'Steuersatz anlegen' }).click();
        const editor = page.getByRole('dialog', { name: 'Steuersatz anlegen', exact: true });
        await editor.getByRole('textbox', { name: 'Name', exact: false }).fill(name);
        await editor.getByRole('spinbutton', { name: 'Steuersatz (%)', exact: false }).fill('7.5');
        const create = page.waitForResponse(response => response.url().endsWith('/api/tax') && response.request().method() === 'POST');
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        expect((await create).ok()).toBeTruthy();
        await expect(editor).not.toBeVisible();
        const search = await request.post('/api/search/tax', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
        const tax = (await search.json()).data[0];
        id = tax.id;
        expect(tax.taxRate).toBe(7.5);
        await listing.getByRole('textbox', { name: 'Steuersätze suchen' }).fill(name);
        await listing.getByRole('row').filter({ hasText: name }).dblclick();
        const edit = page.getByRole('dialog', { name: 'Steuersatz bearbeiten', exact: true });
        await edit.getByRole('spinbutton', { name: 'Position', exact: false }).fill('5');
        const update = page.waitForResponse(response => response.url().endsWith(`/api/tax/${id}`) && response.request().method() === 'PATCH');
        await edit.getByRole('button', { name: 'Speichern', exact: true }).click();
        const response = await update;
        expect(response.ok()).toBeTruthy();
        expect(response.request().postDataJSON()).toEqual({ position: 5 });
    } finally {
        if (!id) {
            const search = await request.post('/api/search/tax', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
            id = (await search.json()).data?.[0]?.id;
        }
        if (id) expect((await request.delete(`/api/tax/${id}`, { headers })).ok()).toBeTruthy();
    }
});

async function chooseReference(page, dialog, label, value, search = value) {
    const combo = dialog.getByRole('combobox', { name: label, exact: false });
    const input = await combo.evaluate(element => element.tagName === 'INPUT') ? combo : combo.locator('input');
    await input.fill(search);
    await page.getByRole('option', { name: value, exact: true }).click();
}

test('Kunde mit Rechnungs- und Lieferadresse über echte Referenzauswahl anlegen', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const email = `emz-admin-customer-${Date.now()}@example.invalid`;
    let id: string | undefined;
    const first = async entity => (await (await request.post(`/api/search/${entity}`, { headers, data: { limit: 1 } })).json()).data[0];
    const [group, channel, country] = await Promise.all([first('customer-group'), first('sales-channel'), first('country')]);
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'customers'; });
        await page.getByRole('dialog', { name: 'Kunden', exact: true }).getByRole('button', { name: 'Kunde anlegen' }).click();
        const editor = page.getByRole('dialog', { name: 'Kunde anlegen', exact: true });
        await editor.getByRole('textbox', { name: 'Kundennummer', exact: false }).fill(`EMZ-TEST-${Date.now()}`);
        await editor.getByRole('textbox', { name: 'Vorname', exact: false }).fill('Ext');
        await editor.getByRole('textbox', { name: 'Nachname', exact: false }).fill('Browsertest');
        await editor.getByRole('textbox', { name: 'E-Mail', exact: false }).fill(email);
        await chooseReference(page, editor, 'Kundengruppe', group.name);
        await chooseReference(page, editor, /^Verkaufskanal:/, channel.name);
        await editor.getByLabel('Initiales Passwort', { exact: false }).fill(randomUUID());
        await editor.getByRole('textbox', { name: 'Straße und Hausnummer', exact: false }).fill('Teststraße 1');
        await editor.getByRole('textbox', { name: 'Postleitzahl', exact: false }).fill('12345');
        await editor.getByRole('textbox', { name: /^Ort:/ }).fill('Teststadt');
        await chooseReference(page, editor, /^Land:/, country.name);
        const validity = await editor.evaluate(element => (window as any).Ext.getCmp(element.id).query('field')
            .filter(field => !field.isValid()).map(field => ({ name: field.getName(), errors: field.getErrors() })));
        expect(validity).toEqual([]);
        const create = page.waitForResponse(response => response.url().endsWith('/api/customer') && response.request().method() === 'POST', { timeout: 10000 });
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        expect((await create).ok()).toBeTruthy();
        await expect(editor).not.toBeVisible();
        const result = await request.post('/api/search/customer', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'email', value: email }], associations: { defaultBillingAddress: {} } } });
        const customer = (await result.json()).data[0];
        id = customer.id;
        expect(customer.defaultBillingAddress.street).toBe('Teststraße 1');
        expect(customer.defaultShippingAddressId).toBe(customer.defaultBillingAddressId);
    } finally {
        if (!id) {
            const search = await request.post('/api/search/customer', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'email', value: email }] } });
            id = (await search.json()).data?.[0]?.id;
        }
        if (id) expect((await request.delete(`/api/customer/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Medium als Binärdatei hochladen und in der Medienverwaltung finden', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const name = `emz-admin-media-${Date.now()}`;
    let id: string | undefined;
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'media'; });
        const listing = page.getByRole('dialog', { name: 'Medien', exact: true });
        await listing.getByRole('button', { name: 'Datei hochladen' }).click();
        const dialog = page.getByRole('dialog', { name: 'Datei hochladen', exact: true });
        const buffer = await readFile('../../vendor/shopware/administration/Resources/public/administration/static/img/favicon/favicon-32x32.png');
        await dialog.locator('input[type=file]').setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer });
        const created = page.waitForResponse(response => response.url().endsWith('/api/media') && response.request().method() === 'POST');
        await dialog.getByRole('button', { name: 'Hochladen', exact: true }).click();
        const create = await created;
        expect(create.ok()).toBeTruthy();
        id = create.request().postDataJSON().id;
        await expect(dialog).not.toBeVisible({ timeout: 10000 });
        await listing.getByRole('textbox', { name: 'Medien suchen' }).fill(name);
        await expect(listing.getByRole('row').filter({ hasText: name })).toBeVisible();
        const result = await request.post('/api/search/media', { headers, data: { ids: [id], limit: 1 } });
        const media = (await result.json()).data[0];
        expect(media.hasFile).toBeTruthy();
        expect(media.fileExtension).toBe('png');
        expect(media.fileSize).toBe(buffer.length);
    } finally {
        if (id) expect((await request.delete(`/api/media/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Bestelldetails laden Positionen, Lieferungen, Zahlungen und Belege ohne Schreibzugriff', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const order = await createTestOrder(request, headers);
    try {
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (['PATCH', 'DELETE'].includes(request.method()) || (request.method() === 'POST' && request.url().includes('/_action/order'))) writes.push(request.url());
    });
    await login(page);
    await page.evaluate(() => { location.hash = 'orders'; });
    const listing = page.getByRole('dialog', { name: 'Bestellungen', exact: true });
    await listing.getByRole('textbox', { name: 'Bestellungen suchen' }).fill(order.orderNumber);
    await listing.getByRole('row').filter({ hasText: order.orderNumber }).dblclick();
    const detail = page.getByRole('dialog', { name: `Bestellung ${order.orderNumber}`, exact: true });
    await expect(detail.getByRole('heading', { name: `Bestellung ${order.orderNumber}` })).toBeVisible();
    for (const title of ['Positionen', 'Lieferungen', 'Zahlungen', 'Belege']) {
        await detail.getByRole('tab', { name: title, exact: true }).click();
        await expect(detail.locator('.x-toolbar-text:visible').filter({ hasText: /Seite 1 von/ })).toBeVisible();
    }
    await detail.getByRole('tab', { name: 'Übersicht', exact: true }).click();
    await detail.getByRole('button', { name: 'Bestellstatus ändern' }).click();
    const status = page.getByRole('dialog', { name: 'Bestellstatus', exact: true });
    await expect(status.getByRole('combobox', { name: 'Neuer Status' })).toBeVisible();
    await expect(status.getByRole('checkbox', { name: 'Status-E-Mail an Kunden senden' })).not.toBeChecked();
    await status.getByRole('button', { name: 'Abbrechen' }).click();
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
    } finally {
        expect((await request.delete(`/api/order/${order.id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Bestellposition im Entwurf ändern, neu berechnen und erst beim Übernehmen veröffentlichen', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request);
    const order = await createTestOrder(request, headers);
    let versionId: string | undefined;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const readOrder = async () => (await (await request.post('/api/search/order', { headers, data: { ids: [order.id], limit: 1, associations: { lineItems: {}, deliveries: {}, orderCustomer: {} } } })).json()).data[0];
    try {
        await login(page); await page.evaluate(() => { location.hash = 'orders'; });
        const list = page.getByRole('dialog', { name: 'Bestellungen', exact: true });
        await list.getByRole('textbox', { name: 'Bestellungen suchen' }).fill(order.orderNumber);
        await list.getByRole('row').filter({ hasText: order.orderNumber }).dblclick();
        const detail = page.getByRole('dialog', { name: `Bestellung ${order.orderNumber}`, exact: true });
        const created = page.waitForResponse(response => response.url().endsWith(`/api/_action/version/order/${order.id}`));
        await detail.getByRole('button', { name: 'Bestellung bearbeiten', exact: true }).click();
        versionId = (await (await created).json()).versionId;
        const draft = page.getByRole('dialog', { name: 'Bestellung bearbeiten', exact: true });
        await draft.getByRole('row').filter({ hasText: 'Ext-Admin-Testposition' }).dblclick();
        const position = page.getByRole('dialog', { name: 'Position bearbeiten', exact: true });
        await position.getByRole('spinbutton', { name: /^Menge:/ }).fill('2');
        await position.getByRole('button', { name: 'Speichern', exact: true }).click();
        await expect(position).not.toBeVisible();
        await draft.getByRole('tab', { name: 'Versand', exact: true }).click();
        await draft.getByRole('tabpanel', { name: 'Versand', exact: true }).locator('.x-grid-item').first().dblclick();
        const delivery = page.getByRole('dialog', { name: 'Lieferung bearbeiten', exact: true });
        await delivery.getByRole('spinbutton', { name: 'Versandkosten in Bestellwährung:', exact: true }).fill('5');
        await delivery.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(delivery).not.toBeVisible();
        await draft.getByRole('button', { name: 'Kundendaten', exact: true }).click();
        const customer = page.getByRole('dialog', { name: 'Bestellkundendaten bearbeiten', exact: true });
        await customer.getByRole('textbox', { name: 'Nachname:', exact: true }).fill('Entwurfskunde'); await customer.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(customer).not.toBeVisible();
        await draft.getByRole('button', { name: 'Bestelldaten', exact: true }).click();
        const metadata = page.getByRole('dialog', { name: 'Bestelldaten bearbeiten', exact: true });
        await metadata.getByRole('textbox', { name: 'Partnercode:', exact: true }).fill('EMZ-DRAFT'); await metadata.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(metadata).not.toBeVisible();
        await draft.getByRole('button', { name: 'Neu berechnen', exact: true }).click();
        await expect(draft.getByText(/Gesamt:.*43/)).toBeVisible();
        expect((await readOrder()).lineItems[0].quantity).toBe(1);
        expect((await readOrder()).deliveries[0].shippingCosts.totalPrice).toBe(0); expect((await readOrder()).orderCustomer.lastName).toBe('Browsertest');
        await draft.getByRole('button', { name: 'Änderungen übernehmen', exact: true }).click();
        await expect(draft).not.toBeVisible(); versionId = undefined;
        const saved = await readOrder(); expect(saved.lineItems[0].quantity).toBe(2); expect(saved.amountTotal).toBe(43);
        expect(saved.deliveries[0].shippingCosts.totalPrice).toBe(5); expect(saved.orderCustomer.lastName).toBe('Entwurfskunde'); expect(saved.affiliateCode).toBe('EMZ-DRAFT');
        await expect(detail).toBeVisible();
        const secondVersion = page.waitForResponse(response => response.url().endsWith(`/api/_action/version/order/${order.id}`));
        await detail.getByRole('button', { name: 'Bestellung bearbeiten', exact: true }).click();
        versionId = (await (await secondVersion).json()).versionId;
        await draft.getByRole('row').filter({ hasText: 'Ext-Admin-Testposition' }).dblclick();
        await position.getByRole('spinbutton', { name: /^Menge:/ }).fill('3');
        await position.getByRole('button', { name: 'Speichern', exact: true }).click();
        await expect(position).not.toBeVisible();
        await draft.getByRole('button', { name: 'Verwerfen', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: /Ja|Yes/ }).click();
        await expect(draft).not.toBeVisible(); versionId = undefined;
        expect((await readOrder()).lineItems[0].quantity).toBe(2);
        expect(errors).toEqual([]);
    } finally {
        if (versionId) expect((await request.post(`/api/_action/version/${versionId}/order/${order.id}`, { headers, data: {} })).ok()).toBeTruthy();
        expect((await request.delete(`/api/order/${order.id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Neue Bestellung aus einem berechneten Warenkorb ohne E-Mail-Versand anlegen', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request);
    const customerId = randomUUID().replaceAll('-', ''); const addressId = randomUUID().replaceAll('-', '');
    const email = `emz-cart-${customerId}@example.invalid`;
    const channel = (await (await request.post('/api/search/sales-channel', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'active', value: true }] } })).json()).data[0];
    const salutation = (await (await request.post('/api/search/salutation', { headers, data: { limit: 1 } })).json()).data[0];
    let orderId: string | undefined;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        expect((await request.post('/api/customer', { headers, data: { id: customerId, customerNumber: `EMZ-CART-${Date.now()}`, email, password: randomUUID(), active: true,
            firstName: 'Ext', lastName: 'Warenkorb', salutationId: salutation.id, groupId: channel.customerGroupId, salesChannelId: channel.id, defaultBillingAddressId: addressId, defaultShippingAddressId: addressId,
            addresses: [{ id: addressId, firstName: 'Ext', lastName: 'Warenkorb', salutationId: salutation.id, street: 'Teststraße 1', city: 'Teststadt', zipcode: '12345', countryId: channel.countryId }] } })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'orders'; });
        await page.getByRole('dialog', { name: 'Bestellungen', exact: true }).getByRole('button', { name: 'Bestellung anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Bestellung anlegen', exact: true });
        await chooseReference(page, editor, 'Verkaufskanal', channel.name);
        await chooseReference(page, editor, 'Kunde', `${email} · Ext · Warenkorb`, email);
        await editor.getByRole('button', { name: 'Warenkorb vorbereiten', exact: true }).click();
        await editor.getByRole('button', { name: 'Freie Position', exact: true }).click();
        const position = page.getByRole('dialog', { name: 'Warenkorbposition', exact: true });
        await position.getByRole('textbox', { name: /^Bezeichnung:/ }).fill('EMZ Warenkorb-Testposition');
        await position.getByRole('spinbutton', { name: 'Einzelpreis' }).fill('12.5');
        await position.getByRole('spinbutton', { name: /^Menge:/ }).fill('2');
        await position.getByRole('button', { name: 'Position übernehmen' }).click();
        await expect(position).not.toBeVisible();
        await editor.getByRole('tab', { name: 'Abschluss', exact: true }).click();
        await expect(editor.getByRole('checkbox', { name: /Bestellbestätigung/ })).not.toBeChecked();
        await expect(editor.getByRole('button', { name: 'Bestellung verbindlich anlegen', exact: true })).toBeEnabled();
        const [created] = await Promise.all([
            page.waitForResponse(response => response.url().includes('/api/_proxy-order/') && response.request().method() === 'POST'),
            editor.getByRole('button', { name: 'Bestellung verbindlich anlegen', exact: true }).click(),
        ]);
        const result = await created.json();
        expect(created.ok(), result.errors?.[0]?.detail).toBeTruthy(); orderId = result.id;
        expect(created.request().postDataJSON().sendOrderConfirmationMail).toBe(false);
        await expect(editor).not.toBeVisible();
        const order = (await (await request.post('/api/search/order', { headers, data: { ids: [orderId], limit: 1, associations: { lineItems: {}, orderCustomer: {} } } })).json()).data[0];
        expect(order.orderCustomer.customerId).toBe(customerId); expect(order.lineItems).toHaveLength(1);
        expect(order.lineItems[0].quantity).toBe(2); expect(order.lineItems[0].price.totalPrice).toBe(25);
        expect(errors).toEqual([]);
    } finally {
        if (!orderId) {
            const result = await request.post('/api/search/order', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'orderCustomer.customerId', value: customerId }] } });
            orderId = (await result.json()).data[0]?.id;
        }
        if (orderId) expect((await request.delete(`/api/order/${orderId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/customer/${customerId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Versandpreisstaffel mit Regelgrenzen und Systemwährung speichern', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const shippingId = randomUUID().replaceAll('-', ''); const name = `EMZ-SHIPPING-${Date.now()}`;
    const delivery = (await (await request.post('/api/search/delivery-time', { headers, data: { limit: 1 } })).json()).data[0];
    try {
        expect((await request.post('/api/shipping-method', { headers, data: { id: shippingId, name, technicalName: name, deliveryTimeId: delivery.id, active: false, taxType: 'auto' } })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'shipping-methods'; });
        const list = page.getByRole('dialog', { name: 'Versandarten', exact: true });
        await list.getByRole('textbox', { name: 'Versandarten suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Versandart bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Versandpreise', exact: true }).click();
        await editor.getByRole('button', { name: 'Versandpreis anlegen', exact: true }).click();
        const price = page.getByRole('dialog', { name: 'Versandpreis anlegen', exact: true });
        await price.getByRole('spinbutton', { name: 'Versandpreis brutto' }).fill('5.95');
        await price.getByRole('spinbutton', { name: 'Versandpreis netto' }).fill('5');
        await price.getByRole('spinbutton', { name: 'Bis (' }).fill('100');
        await price.getByRole('button', { name: 'Speichern', exact: true }).click();
        await expect(price).not.toBeVisible();
        const prices = (await (await request.post('/api/search/shipping-method-price', { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'shippingMethodId', value: shippingId }] } })).json()).data;
        expect(prices).toHaveLength(1); expect(prices[0].quantityEnd).toBe(100); expect(prices[0].calculation).toBe(2);
        expect(prices[0].currencyPrice[0].gross).toBe(5.95);
    } finally { expect((await request.delete(`/api/shipping-method/${shippingId}`, { headers })).ok()).toBeTruthy(); }
});

test('Zusatzfeld-Set mit Produkteinsatz und Auswahlfeld anlegen', async ({ page, request }) => {
    test.setTimeout(60000);
    const headers = await integrationHeaders(request); const name = `emz_fields_${Date.now()}`; let setId: string | undefined;
    try {
        await login(page); await page.evaluate(() => { location.hash = 'custom-fields'; });
        const list = page.getByRole('dialog', { name: 'Zusatzfelder', exact: true });
        await list.getByRole('button', { name: 'Zusatzfeld-Set anlegen', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'Zusatzfeld-Set anlegen', exact: true });
        await create.getByRole('textbox', { name: 'Technischer Name' }).fill(name);
        await create.getByRole('textbox', { name: 'Beschriftung Deutsch' }).fill(name);
        await create.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(create).not.toBeVisible();
        const sets = await request.post('/api/search/custom-field-set', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
        setId = (await sets.json()).data[0].id;
        await list.getByRole('textbox', { name: 'Zusatzfelder suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Zusatzfeld-Set bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Verwendung', exact: true }).click();
        await editor.getByRole('button', { name: 'Verwendung anlegen' }).click();
        const usage = page.getByRole('dialog', { name: 'Verwendung anlegen', exact: true });
        await usage.getByRole('combobox', { name: 'Bereich' }).click(); await page.getByRole('option', { name: 'Produkte', exact: true }).click();
        await usage.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(usage).not.toBeVisible();
        await editor.getByRole('tab', { name: 'Felder', exact: true }).click();
        await editor.getByRole('button', { name: 'Zusatzfeld anlegen', exact: true }).click();
        const field = page.getByRole('dialog', { name: 'Zusatzfeld anlegen', exact: true });
        await field.getByRole('textbox', { name: 'Technischer Name' }).fill(`${name}_select`);
        await field.getByRole('combobox', { name: 'Feldtyp' }).click(); await page.getByRole('option', { name: 'Auswahl', exact: true }).click();
        await field.getByRole('textbox', { name: 'Beschriftung Deutsch' }).fill('Testauswahl');
        await field.getByRole('textbox', { name: 'Auswahlwerte' }).fill('red = Rot\nblue = Blau');
        await field.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(field).not.toBeVisible();
        const fields = (await (await request.post('/api/search/custom-field', { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'customFieldSetId', value: setId }] } })).json()).data;
        expect(fields).toHaveLength(1); expect(fields[0].type).toBe('select'); expect(fields[0].config.options.map(item => item.value)).toEqual(['red', 'blue']);
    } finally {
        if (!setId) setId = (await (await request.post('/api/search/custom-field-set', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } })).json()).data[0]?.id;
        if (setId) expect((await request.delete(`/api/custom-field-set/${setId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Integration mit einer Leserolle anlegen und per Client-Credentials anmelden', async ({ page, request }) => {
    test.setTimeout(60000);
    const headers = await integrationHeaders(request);
    const roleId = randomUUID().replaceAll('-', ''); const name = `EMZ-INTEGRATION-${Date.now()}`;
    let integrationId: string | undefined;
    try {
        expect((await request.post('/api/acl-role', { headers, data: { id: roleId, name, privileges: ['product:read'] } })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'integrations'; });
        const list = page.getByRole('dialog', { name: 'Integrationen', exact: true });
        await list.getByRole('button', { name: 'Integration anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Integration anlegen', exact: true });
        await editor.getByRole('textbox', { name: /^Name:/ }).fill(name);
        const accessKey = await editor.getByRole('textbox', { name: 'Zugangs-ID' }).inputValue();
        const secretAccessKey = await editor.getByRole('textbox', { name: 'Geheimer Schlüssel' }).inputValue();
        await editor.getByRole('textbox', { name: /^Rollen:/ }).fill(name);
        await page.getByRole('option', { name, exact: true }).click();
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(editor).not.toBeVisible();
        const found = await request.post('/api/search/integration', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'label', value: name }], associations: { aclRoles: {} } } });
        const integration = (await found.json()).data[0]; integrationId = integration.id;
        expect(integration.admin).toBe(false); expect(integration.aclRoles.map(role => role.id)).toEqual([roleId]);
        const auth = await request.post('/api/oauth/token', { data: { grant_type: 'client_credentials', client_id: accessKey, client_secret: secretAccessKey } });
        expect(auth.ok()).toBeTruthy();
        const readerHeaders = { Authorization: `Bearer ${(await auth.json()).access_token}`, Accept: 'application/json' };
        expect((await request.post('/api/search/product', { headers: readerHeaders, data: { limit: 1 } })).ok()).toBeTruthy();
        expect((await request.post('/api/search/customer', { headers: readerHeaders, data: { limit: 1 } })).status()).toBe(403);
        expect((await request.post('/api/_action/emz-ext-admin/message-queue/consume', { headers: readerHeaders, data: { receiver: 'async' } })).status()).toBe(403);
    } finally {
        if (!integrationId) integrationId = (await (await request.post('/api/search/integration', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'label', value: name }] } })).json()).data[0]?.id;
        if (integrationId) expect((await request.delete(`/api/integration/${integrationId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/acl-role/${roleId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Rule Builder speichert verschachtelte Bedingungen und erhält sie beim Umbenennen', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const name = `EMZ-ADMIN-RULE-${Date.now()}`;
    let id: string | undefined;
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'rules'; });
        const listing = page.getByRole('dialog', { name: 'Rule Builder', exact: true });
        await listing.getByRole('button', { name: 'Regel anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Regel anlegen', exact: true });
        await editor.getByRole('textbox', { name: /^Name:/ }).fill(name);
        await editor.getByRole('button', { name: 'Bedingung hinzufügen' }).click();
        const condition = page.getByRole('dialog', { name: 'Bedingung bearbeiten', exact: true });
        await condition.getByRole('combobox', { name: /^Bedingung:/ }).click();
        await page.getByRole('option', { name: 'Warenkorbwert', exact: true }).click();
        await condition.getByRole('combobox', { name: /^Vergleich:/ }).click();
        await page.getByRole('option', { name: 'Größer oder gleich', exact: true }).click();
        await condition.getByRole('spinbutton', { name: /^Wert:/ }).fill('100');
        await condition.getByRole('button', { name: 'Übernehmen' }).click();
        await expect(editor.getByRole('gridcell').filter({ hasText: 'Warenkorbwert' })).toBeVisible();
        const create = page.waitForResponse(response => response.url().endsWith('/api/_action/sync') && response.request().method() === 'POST');
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        const created = await create;
        expect(created.ok(), (await created.json()).errors?.[0]?.detail).toBeTruthy();
        await expect(editor).not.toBeVisible();
        const search = await request.post('/api/search/rule', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
        id = (await search.json()).data[0].id;
        const readConditions = async () => (await (await request.post('/api/search/rule-condition', { headers, data: { limit: 25, filter: [{ type: 'equals', field: 'ruleId', value: id }] } })).json()).data;
        const initial = await readConditions();
        expect(initial).toHaveLength(2);
        const amount = initial.find(item => item.type === 'cartCartAmount');
        expect(amount.value).toEqual({ operator: '>=', amount: 100 });
        expect(amount.parentId).toBe(initial.find(item => item.type === 'andContainer').id);
        await listing.getByRole('textbox', { name: 'Rule Builder suchen' }).fill(name);
        await listing.getByRole('row').filter({ hasText: name }).dblclick();
        const edit = page.getByRole('dialog', { name: 'Regel bearbeiten', exact: true });
        await edit.getByRole('textbox', { name: /^Name:/ }).fill(`${name}-updated`);
        const update = page.waitForResponse(response => response.url().endsWith('/api/_action/sync') && response.request().method() === 'POST');
        await edit.getByRole('button', { name: 'Speichern', exact: true }).click();
        const response = await update;
        expect(response.ok()).toBeTruthy();
        expect(response.request().postDataJSON()).toEqual({ rule: { action: 'upsert', entity: 'rule', payload: [{ id, name: `${name}-updated` }] } });
        const after = await readConditions();
        expect(after.map(item => [item.id, item.type, item.value])).toEqual(initial.map(item => [item.id, item.type, item.value]));
    } finally {
        if (!id) {
            const result = await request.post('/api/search/rule', { headers, data: { limit: 1, filter: [{ type: 'contains', field: 'name', value: name }] } });
            id = (await result.json()).data?.[0]?.id;
        }
        if (id) expect((await request.delete(`/api/rule/${id}`, { headers })).ok()).toBeTruthy();
    }
});

async function createTestOrder(request, headers) {
    const first = async (entity, filter = []) => {
        const result = await request.post(`/api/search/${entity}`, { headers, data: { limit: 1, filter } });
        expect(result.ok()).toBeTruthy();
        return (await result.json()).data[0];
    };
    const state = entity => first('state-machine-state', [
        { type: 'equals', field: 'stateMachine.technicalName', value: entity },
        { type: 'equals', field: 'technicalName', value: 'open' },
    ]);
    const [currency, language, channel, country, shipping, payment, orderState, deliveryState, transactionState] = await Promise.all([
        first('currency'), first('language'), first('sales-channel'), first('country'), first('shipping-method'), first('payment-method'),
        state('order.state'), state('order_delivery.state'), state('order_transaction.state'),
    ]);
    const id = randomUUID().replaceAll('-', '');
    const addressId = randomUUID().replaceAll('-', '');
    const price = { unitPrice: 19, totalPrice: 19, quantity: 1, calculatedTaxes: [], taxRules: [] };
    const payload = {
        id, orderNumber: `EMZ-ADMIN-ORDER-${Date.now()}`, orderDateTime: new Date().toISOString(),
        currencyId: currency.id, currencyFactor: currency.factor, languageId: language.id, salesChannelId: channel.id, stateId: orderState.id,
        billingAddressId: addressId, itemRounding: { decimals: currency.itemRounding.decimals, interval: currency.itemRounding.interval, roundForNet: currency.itemRounding.roundForNet },
        totalRounding: { decimals: currency.totalRounding.decimals, interval: currency.totalRounding.interval, roundForNet: currency.totalRounding.roundForNet },
        price: { netPrice: 19, totalPrice: 19, positionPrice: 19, rawTotal: 19, calculatedTaxes: [], taxRules: [], taxStatus: 'tax-free' },
        shippingCosts: { ...price, unitPrice: 0, totalPrice: 0 },
        orderCustomer: { email: `emz-order-${id}@example.invalid`, firstName: 'Ext', lastName: 'Browsertest' },
        addresses: [{ id: addressId, countryId: country.id, firstName: 'Ext', lastName: 'Browsertest', street: 'Teststraße 1', zipcode: '12345', city: 'Teststadt' }],
        lineItems: [{ id: randomUUID().replaceAll('-', ''), identifier: id, label: 'Ext-Admin-Testposition', quantity: 1, position: 1, type: 'custom', states: [], price,
            priceDefinition: { type: 'quantity', price: 19, quantity: 1, isCalculated: true, taxRules: [] } }],
        deliveries: [{ shippingOrderAddressId: addressId, shippingMethodId: shipping.id, stateId: deliveryState.id, trackingCodes: [],
            shippingDateEarliest: new Date().toISOString(), shippingDateLatest: new Date().toISOString(), shippingCosts: { ...price, unitPrice: 0, totalPrice: 0 } }],
        transactions: [{ paymentMethodId: payment.id, stateId: transactionState.id, amount: price }],
    };
    const result = await request.post('/api/order', { headers, data: payload });
    expect(result.ok(), (await result.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
    return payload;
}

test('Erlebniswelt mit Abschnitt, Textblock und HTML-Inhalt bearbeiten', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const id = randomUUID().replaceAll('-', '');
    const name = `EMZ-ADMIN-CMS-${Date.now()}`;
    const created = await request.post('/api/cms-page', { headers, data: { id, name, type: 'page' } });
    expect(created.ok()).toBeTruthy();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'cms'; });
        const listing = page.getByRole('dialog', { name: 'Erlebniswelten', exact: true });
        await listing.getByRole('textbox', { name: 'Erlebniswelten suchen' }).fill(name);
        await listing.getByRole('row').filter({ hasText: name }).dblclick();
        const cms = page.getByRole('dialog', { name: 'Erlebniswelt bearbeiten', exact: true });
        await cms.getByRole('tab', { name: 'Abschnitte', exact: true }).click();
        await cms.getByRole('button', { name: 'Abschnitt anlegen', exact: true }).click();
        const section = page.getByRole('dialog', { name: 'Abschnitt anlegen', exact: true });
        await section.getByRole('textbox', { name: /^Name:/ }).fill('Inhalt');
        await section.getByRole('button', { name: 'Speichern', exact: true }).click();
        await expect(section).not.toBeVisible();
        await cms.getByRole('row').filter({ hasText: 'Inhalt' }).dblclick();
        const sectionEdit = page.getByRole('dialog', { name: 'Abschnitt bearbeiten', exact: true });
        await sectionEdit.getByRole('tab', { name: 'Blöcke', exact: true }).click();
        await sectionEdit.getByRole('button', { name: 'Block anlegen', exact: true }).click();
        const block = page.getByRole('dialog', { name: 'Block anlegen', exact: true });
        await block.getByRole('textbox', { name: /^Name:/ }).fill('Testtext');
        await block.getByRole('button', { name: 'Speichern', exact: true }).click();
        await expect(block).not.toBeVisible();
        await sectionEdit.getByRole('row').filter({ hasText: 'Testtext' }).dblclick();
        const blockEdit = page.getByRole('dialog', { name: 'Block bearbeiten', exact: true });
        await blockEdit.getByRole('tab', { name: 'Elemente', exact: true }).click();
        await blockEdit.getByRole('row').filter({ hasText: 'Inhalt' }).dblclick();
        const element = page.getByRole('dialog', { name: 'Element bearbeiten', exact: true });
        await element.getByRole('textbox', { name: 'Text (HTML)', exact: false }).fill('<p>Ext-Admin CMS Browsertest</p>');
        const save = page.waitForResponse(response => response.url().includes('/api/cms-slot/') && response.request().method() === 'PATCH');
        await element.getByRole('button', { name: 'Speichern', exact: true }).click();
        expect((await save).ok()).toBeTruthy();
        const read = await request.post('/api/search/cms-slot', { headers, data: { limit: 5, filter: [{ type: 'equals', field: 'block.section.pageId', value: id }] } });
        const slot = (await read.json()).data[0];
        expect(slot.config.content).toEqual({ source: 'static', value: '<p>Ext-Admin CMS Browsertest</p>' });
        expect(slot.config.verticalAlign).toEqual({ source: 'static', value: null });
        expect(errors).toEqual([]);
    } finally {
        expect((await request.delete(`/api/cms-page/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Produktzuordnung ergänzt eine Kategorie und entfernt nur die Zuordnung', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const id = randomUUID().replaceAll('-', '');
    const categories = [0, 1].map(() => ({ id: randomUUID().replaceAll('-', ''), name: `EMZ-RELATION-${randomUUID()}`, type: 'page' }));
    const first = async entity => (await (await request.post(`/api/search/${entity}`, { headers, data: { limit: 1 } })).json()).data[0];
    const tax = await first('tax');
    await page.goto('/admin');
    const currencyId = await page.locator('#emz-admin-config').getAttribute('data-currency-id');
    let created = false;
    const createdCategories: string[] = [];
    try {
        for (const category of categories) {
            expect((await request.post('/api/category', { headers, data: category })).ok()).toBeTruthy();
            createdCategories.push(category.id);
        }
        const productResponse = await request.post('/api/product', { headers, data: { id, name: 'Ext Zuordnungstest', productNumber: `EMZ-RELATION-${id}`, active: false, stock: 0,
            taxId: tax.id, price: [{ currencyId, net: 1, gross: 1, linked: false }], categories: [{ id: categories[0].id }] } });
        expect(productResponse.ok(), (await productResponse.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        created = true;
        await login(page);
        await page.evaluate(() => { location.hash = 'products'; });
        const list = page.getByRole('dialog', { name: 'Produkte', exact: true });
        await list.getByRole('textbox', { name: 'Produkte suchen' }).fill(`EMZ-RELATION-${id}`);
        await list.getByRole('row').filter({ hasText: `EMZ-RELATION-${id}` }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true });
        await editor.getByRole('tab', { name: 'Kategorien', exact: true }).click();
        await expect(editor.getByRole('row').filter({ hasText: categories[0].name })).toBeVisible();
        await editor.getByRole('button', { name: 'Zuordnen', exact: true }).click();
        const assign = page.getByRole('dialog', { name: 'Kategorien zuordnen', exact: true });
        await chooseReference(page, assign, 'Kategorien', categories[1].name);
        const added = page.waitForResponse(response => response.url().endsWith(`/api/product/${id}`) && response.request().method() === 'PATCH');
        await assign.getByRole('button', { name: 'Zuordnen', exact: true }).click();
        expect((await added).ok()).toBeTruthy();
        await expect(assign).not.toBeVisible();
        await expect(editor.getByRole('row').filter({ hasText: categories[0].name })).toBeVisible();
        await editor.getByRole('row').filter({ hasText: categories[1].name }).click();
        await editor.getByRole('button', { name: 'Zuordnung entfernen', exact: true }).click();
        const removed = page.waitForResponse(response => response.url().endsWith(`/api/product/${id}/categories/${categories[1].id}`) && response.request().method() === 'DELETE');
        await page.getByRole('alertdialog').getByRole('button', { name: /Ja|Yes/ }).click();
        expect((await removed).ok()).toBeTruthy();
        await expect(editor.getByRole('row').filter({ hasText: categories[1].name })).toHaveCount(0);
        await expect(editor.getByRole('row').filter({ hasText: categories[0].name })).toBeVisible();
        const result = await request.post('/api/search/category', { headers, data: { ids: categories.map(item => item.id), limit: 2 } });
        expect((await result.json()).data).toHaveLength(2);
    } finally {
        if (created) expect((await request.delete(`/api/product/${id}`, { headers })).ok()).toBeTruthy();
        for (const categoryId of createdCategories) expect((await request.delete(`/api/category/${categoryId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Währungsrundung erhält unangetastete Werte und sendet keine API-Metadaten', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const id = randomUUID().replaceAll('-', '');
    const name = `EMZ-ROUNDING-${Date.now()}`;
    const created = await request.post('/api/currency', { headers, data: { id, name, shortName: 'EMZ', isoCode: 'EMZ', symbol: 'E', factor: 1,
        itemRounding: { decimals: 2, interval: 0.05, roundForNet: false }, totalRounding: { decimals: 2, interval: 0.01, roundForNet: true } } });
    expect(created.ok()).toBeTruthy();
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'currencies'; });
        const list = page.getByRole('dialog', { name: 'Währungen', exact: true });
        await list.getByRole('textbox', { name: 'Währungen suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Währung bearbeiten', exact: true });
        await editor.getByRole('spinbutton', { name: 'Nachkommastellen Positionen', exact: false }).fill('3');
        const save = page.waitForResponse(response => response.url().endsWith(`/api/currency/${id}`) && response.request().method() === 'PATCH');
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        const result = await save;
        expect(result.ok()).toBeTruthy();
        expect(result.request().postDataJSON()).toEqual({ itemRounding: { decimals: 3, interval: 0.05, roundForNet: false } });
    } finally {
        expect((await request.delete(`/api/currency/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Neue Rolle benötigt Passwortbestätigung und erhält exakt ausgewählte Rechte', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const name = `EMZ-ADMIN-ROLE-${Date.now()}`;
    let id: string | undefined;
    try {
        await login(page);
        await page.evaluate(() => {
            const key = Object.keys(sessionStorage).find(key => key.startsWith('emz.ext-admin.session:'))!;
            (window as any).__emzLoginToken = JSON.parse(sessionStorage.getItem(key)!).access_token;
            location.hash = 'roles';
        });
        const list = page.getByRole('dialog', { name: 'Rollen & Berechtigungen', exact: true });
        await list.getByRole('button', { name: 'Rolle anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Rolle anlegen', exact: true });
        await editor.getByRole('textbox', { name: /^Name:/ }).fill(name);
        await editor.getByRole('textbox', { name: 'Berechtigungen auswählen', exact: false }).fill('product:read');
        await page.getByRole('option', { name: 'product:read', exact: true }).click();
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        const verification = page.getByRole('dialog', { name: 'Änderung bestätigen', exact: true });
        await expect(verification).toBeVisible();
        const before = await request.post('/api/search/acl-role', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
        expect((await before.json()).data).toHaveLength(0);
        await verification.getByLabel('Dein aktuelles Passwort', { exact: false }).fill('invalid-local-verification-test');
        await verification.getByRole('button', { name: 'Bestätigen', exact: true }).click();
        await expect(verification.getByText('Passwort ungültig oder Sitzung abgelaufen.', { exact: true })).toBeVisible();
        await expect(verification.getByLabel('Dein aktuelles Passwort', { exact: false })).toHaveValue('');
        await verification.getByLabel('Dein aktuelles Passwort', { exact: false }).fill(password);
        const saved = page.waitForResponse(response => response.url().endsWith('/api/acl-role') && response.request().method() === 'POST', { timeout: 10000 });
        await verification.getByRole('button', { name: 'Bestätigen', exact: true }).click();
        const result = await saved;
        expect(result.ok(), (await result.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        id = result.request().postDataJSON().id;
        await expect(editor).not.toBeVisible();
        const read = await request.post('/api/search/acl-role', { headers, data: { ids: [id], limit: 1 } });
        expect((await read.json()).data[0].privileges).toEqual(['product:read']);
        expect(await page.evaluate(() => {
            const key = Object.keys(sessionStorage).find(key => key.startsWith('emz.ext-admin.session:'))!;
            const unchanged = JSON.parse(sessionStorage.getItem(key)!).access_token === (window as any).__emzLoginToken;
            delete (window as any).__emzLoginToken;
            return unchanged;
        })).toBeTruthy();
    } finally {
        if (!id) {
            const result = await request.post('/api/search/acl-role', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
            id = (await result.json()).data?.[0]?.id;
        }
        if (id) expect((await request.delete(`/api/acl-role/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Inaktiven Flow mit einer passenden Kundenaktion anlegen', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const name = `EMZ-ADMIN-FLOW-${Date.now()}`;
    let id: string | undefined;
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'flows'; });
        const list = page.getByRole('dialog', { name: 'Flow Builder', exact: true });
        await list.getByRole('button', { name: 'Flow anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Flow anlegen', exact: true });
        await editor.getByRole('textbox', { name: /^Name:/ }).fill(name);
        await editor.getByRole('combobox', { name: /^Auslöser:/ }).click();
        await page.getByRole('option', { name: 'checkout.customer.login', exact: true }).click();
        await expect(editor.getByRole('checkbox', { name: /^Aktiv:/ })).not.toBeChecked();
        const save = page.waitForResponse(response => response.url().endsWith('/api/flow') && response.request().method() === 'POST', { timeout: 10000 });
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        const result = await save;
        expect(result.ok()).toBeTruthy();
        id = result.request().postDataJSON().id;
        await expect(editor).not.toBeVisible();
        await list.getByRole('textbox', { name: 'Flow Builder suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const flow = page.getByRole('dialog', { name: 'Flow bearbeiten', exact: true });
        await flow.getByRole('tab', { name: 'Ablauf', exact: true }).click();
        await flow.getByRole('button', { name: 'Aktion hinzufügen', exact: true }).click();
        const action = page.getByRole('dialog', { name: 'Aktion auswählen', exact: true });
        await action.getByRole('combobox', { name: /^Aktion:/ }).click();
        await page.getByRole('option', { name: 'Kundenstatus ändern', exact: true }).click();
        await action.getByRole('button', { name: 'Weiter', exact: true }).click();
        const step = page.getByRole('dialog', { name: 'Schritt anlegen', exact: true });
        await step.getByRole('checkbox', { name: 'Kunde aktiv', exact: false }).check();
        const stepSave = page.waitForResponse(response => response.url().endsWith('/api/flow-sequence') && response.request().method() === 'POST', { timeout: 10000 });
        await step.getByRole('button', { name: 'Speichern', exact: true }).click();
        const saved = await stepSave;
        expect(saved.ok(), (await saved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        await expect(step).not.toBeVisible();
        const record = await request.post('/api/search/flow', { headers, data: { ids: [id], limit: 1, associations: { sequences: { limit: 10 } } } });
        const stored = (await record.json()).data[0];
        expect(stored.active).toBeFalsy();
        expect(stored.invalid).toBeFalsy();
        expect(stored.sequences).toHaveLength(1);
        expect(stored.sequences[0].actionName).toBe('action.change.customer.status');
        expect(stored.sequences[0].config).toEqual({ active: true });
    } finally {
        if (!id) {
            const read = await request.post('/api/search/flow', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } });
            id = (await read.json()).data?.[0]?.id;
        }
        if (id) expect((await request.delete(`/api/flow/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Im Flow Builder angelegte Kundenaktion wird bei echter Anmeldung nur für die passende Regel ausgeführt', async ({ page, request }) => {
    test.setTimeout(60000);
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const flowId = uid(); const ruleId = uid(); const tagId = uid(); const name = `EMZ-FLOW-RUN-${Date.now()}`;
    const accounts = [0, 1].map(index => ({ id: uid(), addressId: uid(), email: `emz-flow-${uid()}@example.invalid`, password: randomUUID(), index })); const created: [string, string][] = [];
    const channel = (await (await request.post('/api/search/sales-channel', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'active', value: true }, { type: 'equals', field: 'type.iconName', value: 'regular-storefront' }] } })).json()).data[0];
    const salutation = (await (await request.post('/api/search/salutation', { headers, data: { limit: 1 } })).json()).data[0];
    try {
        for (const account of accounts) {
            expect((await request.post('/api/customer', { headers, data: { id: account.id, customerNumber: `${name}-${account.index}`, email: account.email, password: account.password, active: true,
                firstName: 'Ext', lastName: 'Flow-Test', salutationId: salutation.id, groupId: channel.customerGroupId, salesChannelId: channel.id, defaultBillingAddressId: account.addressId, defaultShippingAddressId: account.addressId,
                addresses: [{ id: account.addressId, firstName: 'Ext', lastName: 'Flow-Test', salutationId: salutation.id, street: 'Teststraße 1', city: 'Teststadt', zipcode: '12345', countryId: channel.countryId }] } })).ok()).toBeTruthy(); created.push(['customer', account.id]);
        }
        for (const [entity, data] of [['tag', { id: tagId, name }], ['rule', { id: ruleId, name, priority: 1, conditions: [{ type: 'andContainer', position: 0, children: [{ type: 'customerEmail', position: 0, value: { operator: '=', email: accounts[0].email } }] }] }],
            ['flow', { id: flowId, name, active: false, priority: 1, eventName: 'checkout.customer.login', sequences: [{ id: uid(), ruleId, position: 1, displayGroup: 1 }] }]] as [string, any][]) {
            expect((await request.post(`/api/${entity}`, { headers, data })).ok()).toBeTruthy(); created.push([entity, data.id]);
        }
        await login(page); await page.evaluate(() => { location.hash = 'flows'; }); const list = page.getByRole('dialog', { name: 'Flow Builder', exact: true }); await list.getByRole('textbox', { name: 'Flow Builder suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Flow bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Ablauf', exact: true }).click(); await editor.getByRole('button', { name: 'Aktion hinzufügen', exact: true }).click();
        const action = page.getByRole('dialog', { name: 'Aktion auswählen', exact: true }); await action.getByRole('combobox', { name: 'Aktion:', exact: true }).click(); await page.getByRole('option', { name: 'Kunden-Tags hinzufügen', exact: true }).click(); await action.getByRole('button', { name: 'Weiter', exact: true }).click();
        const step = page.getByRole('dialog', { name: 'Schritt anlegen', exact: true }); await chooseReference(page, step, 'Übergeordneter Schritt (leer = Start):', `${name} · 1`, name);
        await step.getByRole('checkbox', { name: 'Wenn übergeordnete Bedingung erfüllt ist:', exact: true }).check();
        await step.getByRole('combobox', { name: 'Tags', exact: true }).locator('input').fill(name); await page.getByRole('option', { name, exact: true }).click(); await step.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(step).not.toBeVisible();
        await editor.getByRole('tab', { name: 'Allgemein', exact: true }).click(); await editor.getByRole('checkbox', { name: 'Aktiv:', exact: true }).check(); await editor.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(editor).not.toBeVisible();
        for (const account of accounts) {
            const response = await request.post('/store-api/account/login', { headers: { 'sw-access-key': channel.accessKey }, data: { username: account.email, password: account.password } }); expect(response.ok()).toBeTruthy();
            const customer = (await (await request.post('/api/search/customer', { headers, data: { ids: [account.id], limit: 1, associations: { tags: { limit: 10 } } } })).json()).data[0];
            expect(customer.tags.some(tag => tag.id === tagId)).toBe(account.index === 0);
        }
    } finally { for (const [entity, id] of created.reverse()) expect((await request.delete(`/api/${entity}/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Benutzer mit bestätigtem Passwort anlegen und eigene Testrolle zuordnen', async ({ page, request }) => {
    const headers = await integrationHeaders(request);
    const name = `emz-admin-user-${Date.now()}`;
    const roleId = randomUUID().replaceAll('-', '');
    const roleName = `EMZ-USER-ROLE-${roleId}`;
    const localeResponse = await request.post('/api/search/locale', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'code', value: 'de-DE' }] } });
    const locale = (await localeResponse.json()).data[0];
    let id: string | undefined;
    expect((await request.post('/api/acl-role', { headers, data: { id: roleId, name: roleName, privileges: ['product:read'] } })).ok()).toBeTruthy();
    const confirm = async () => {
        const verification = page.getByRole('dialog', { name: 'Änderung bestätigen', exact: true });
        await verification.getByLabel('Dein aktuelles Passwort', { exact: false }).fill(password);
        await verification.getByRole('button', { name: 'Bestätigen', exact: true }).click();
    };
    try {
        await login(page);
        await page.evaluate(() => { location.hash = 'users'; });
        const list = page.getByRole('dialog', { name: 'Benutzer', exact: true });
        await list.getByRole('button', { name: 'Benutzer anlegen', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Benutzer anlegen', exact: true });
        await editor.getByRole('textbox', { name: 'Benutzername', exact: false }).fill(name);
        await editor.getByRole('textbox', { name: 'Vorname', exact: false }).fill('Ext');
        await editor.getByRole('textbox', { name: 'Nachname', exact: false }).fill('Testbenutzer');
        await editor.getByRole('textbox', { name: 'E-Mail', exact: false }).fill(`${name}@example.invalid`);
        await editor.getByLabel('Initiales Passwort', { exact: false }).fill(randomUUID());
        await chooseReference(page, editor, 'Oberflächensprache', `${locale.code} · ${locale.name}`, locale.code);
        const create = page.waitForResponse(response => response.url().endsWith('/api/user') && response.request().method() === 'POST', { timeout: 10000 });
        await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
        await confirm();
        const created = await create;
        expect(created.ok(), (await created.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        id = created.request().postDataJSON().id;
        await expect(editor).not.toBeVisible();
        await list.getByRole('textbox', { name: 'Benutzer suchen' }).fill(name);
        await list.getByRole('row').filter({ hasText: name }).dblclick();
        const edit = page.getByRole('dialog', { name: 'Benutzer bearbeiten', exact: true });
        await edit.getByRole('tab', { name: 'Rollen', exact: true }).click();
        await edit.getByRole('button', { name: 'Rolle zuordnen', exact: true }).click();
        const role = page.getByRole('dialog', { name: 'Rolle zuordnen', exact: true });
        await chooseReference(page, role, /^Rolle:/, roleName);
        const assign = page.waitForResponse(response => response.url().endsWith(`/api/user/${id}`) && response.request().method() === 'PATCH', { timeout: 10000 });
        await role.getByRole('button', { name: 'Zuordnen', exact: true }).click();
        await confirm();
        expect((await assign).ok()).toBeTruthy();
        await expect(role).not.toBeVisible();
        const read = await request.post('/api/search/user', { headers, data: { ids: [id], limit: 1, associations: { aclRoles: {} } } });
        const user = (await read.json()).data[0];
        expect(user.admin).toBeFalsy();
        expect(user.active).toBeFalsy();
        expect(user.aclRoles.map(role => role.id)).toEqual([roleId]);
    } finally {
        if (!id) {
            const read = await request.post('/api/search/user', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'username', value: name }] } });
            id = (await read.json()).data?.[0]?.id;
        }
        if (id) expect((await request.delete(`/api/user/${id}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/acl-role/${roleId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Eigenes Profil funktioniert mit Profilrecht ohne Benutzerverwaltung', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const id = randomUUID().replaceAll('-', ''); const roleId = randomUUID().replaceAll('-', '');
    const credentials = { username: `emz-profile-${id}`, password: randomUUID() }; let roleCreated = false; let userCreated = false;
    try {
        expect((await request.post('/api/acl-role', { headers, data: { id: roleId, name: `EMZ Profile ${id}`, privileges: ['user_change_me'] } })).ok()).toBeTruthy(); roleCreated = true;
        const locale = (await (await request.post('/api/search/locale', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'code', value: 'de-DE' }] } })).json()).data[0];
        expect((await request.post('/api/user', { headers, data: { id, ...credentials, firstName: 'Profil', lastName: 'Test', email: `${id}@example.invalid`, localeId: locale.id, active: true, admin: false, aclRoles: [{ id: roleId }] } })).ok()).toBeTruthy(); userCreated = true;
        await login(page, credentials); await page.getByRole('button', { name: 'Mein Profil', exact: true }).click();
        const profile = page.getByRole('dialog', { name: 'Mein Profil', exact: true });
        await profile.getByRole('textbox', { name: 'Vorname:', exact: true }).fill('Geändertes Profil');
        await profile.getByRole('button', { name: 'Profil speichern', exact: true }).click();
        const confirmation = page.getByRole('dialog', { name: 'Änderung bestätigen', exact: true });
        await confirmation.getByRole('textbox', { name: 'Dein aktuelles Passwort:' }).fill(credentials.password);
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_info/me') && response.request().method() === 'PATCH'), confirmation.getByRole('button', { name: 'Bestätigen', exact: true }).click()]);
        expect(saved.ok()).toBeTruthy(); await expect(confirmation).not.toBeVisible();
        const user = (await (await request.post('/api/search/user', { headers, data: { ids: [id], limit: 1 } })).json()).data[0];
        expect(user.firstName).toBe('Geändertes Profil'); expect(user.admin).toBe(false); expect(user.username).toBe(credentials.username);
    } finally {
        if (userCreated) expect((await request.delete(`/api/user/${id}`, { headers })).ok()).toBeTruthy();
        if (roleCreated) expect((await request.delete(`/api/acl-role/${roleId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Passwort-Recovery zeigt anonyme Bestätigung und behandelt ungültige Links', async ({ page }) => {
    await page.goto('/admin'); await page.getByRole('button', { name: 'Passwort vergessen?', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Passwort zurücksetzen', exact: true });
    await dialog.getByRole('textbox', { name: 'E-Mail:' }).fill(`${randomUUID()}@example.invalid`);
    await dialog.getByRole('button', { name: 'Link anfordern', exact: true }).click();
    await expect(dialog).toContainText('Wenn ein passendes Konto existiert');
    await page.goto(`/admin#/login/user-recovery/${randomUUID().replaceAll('-', '')}`);
    dialog = page.getByRole('dialog', { name: 'Passwort zurücksetzen', exact: true });
    const newPassword = randomUUID();
    await dialog.getByRole('textbox', { name: 'Neues Passwort:', exact: true }).fill(newPassword);
    await dialog.getByRole('textbox', { name: 'Neues Passwort wiederholen:', exact: true }).fill(newPassword);
    await dialog.getByRole('button', { name: 'Passwort speichern', exact: true }).click();
    await expect(dialog).toContainText('Der Link ist ungültig oder abgelaufen');
});

test('Lokale Recovery-Mail setzt das Passwort zurück und verbraucht den Link genau einmal', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const id = randomUUID().replaceAll('-', '');
    const account = { username: `emz-recovery-${id}`, password: randomUUID() }; const email = `${account.username}@example.invalid`;
    const locale = (await (await request.post('/api/search/locale', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'code', value: 'de-DE' }] } })).json()).data[0];
    const mailpit = (path: string, method = 'GET', body?: object) => {
        const args = ['exec', 'curl', '--silent', '--show-error', '--fail', '--max-time', '10', '-X', method, `http://localhost:8025/api/v1${path}`];
        if (body) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(body));
        const raw = execFileSync('ddev', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return raw.trim().startsWith('{') ? JSON.parse(raw) : null;
    };
    const messages = () => mailpit(`/search?query=${encodeURIComponent(`to:${email}`)}`).messages || [];
    let created = false;
    try {
        mailpit('/info');
        expect((await request.post('/api/user', { headers, data: { id, ...account, email, firstName: 'Recovery', lastName: 'Test', localeId: locale.id, active: true, admin: true } })).ok()).toBeTruthy(); created = true;
        await page.goto('/admin'); await page.getByRole('button', { name: 'Passwort vergessen?', exact: true }).click();
        let dialog = page.getByRole('dialog', { name: 'Passwort zurücksetzen', exact: true });
        await dialog.getByRole('textbox', { name: 'E-Mail:' }).fill(email); await dialog.getByRole('button', { name: 'Link anfordern', exact: true }).click();
        await expect(dialog).toContainText('Wenn ein passendes Konto existiert');
        await expect.poll(async () => {
            if (messages().length) return true;
            await request.post('/api/_action/emz-ext-admin/message-queue/consume', { headers, data: { receiver: 'async' }, timeout: 40000 });
            return messages().length > 0;
        }, { timeout: 45000, intervals: [1000, 2000] }).toBe(true);
        const mail = mailpit(`/message/${messages()[0].ID}`);
        const hash = `${mail.Text || ''}\n${mail.HTML || ''}`.match(/#\/login\/user-recovery\/([a-zA-Z0-9]{32})/)?.[1];
        expect(Boolean(hash), 'Die lokale E-Mail enthält einen gültigen Recovery-Link').toBeTruthy();
        await page.goto(`/admin#/login/user-recovery/${hash}`); dialog = page.getByRole('dialog', { name: 'Passwort zurücksetzen', exact: true });
        const submit = async (value: string) => {
            await dialog.getByRole('textbox', { name: 'Neues Passwort:', exact: true }).fill(value);
            await dialog.getByRole('textbox', { name: 'Neues Passwort wiederholen:', exact: true }).fill(value);
            const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/user/user-recovery/password')), dialog.getByRole('button', { name: 'Passwort speichern', exact: true }).click()]);
            return response;
        };
        expect((await submit('x')).ok()).toBeFalsy();
        await expect(dialog).not.toContainText('Der Link ist ungültig oder abgelaufen');
        const newPassword = randomUUID(); expect((await submit(newPassword)).ok()).toBeTruthy();
        await expect(dialog).toContainText('Das Passwort wurde geändert');
        expect(new URL(page.url()).hash).toBe('');
        const oldLogin = await request.post('/api/oauth/token', { data: { grant_type: 'password', client_id: 'administration', ...account } });
        expect(oldLogin.ok()).toBeFalsy();
        const replay = await request.patch('/api/_action/user/user-recovery/password', { data: { hash, password: account.password, passwordConfirm: account.password } });
        expect(replay.status()).toBe(400);
        await login(page, { username: account.username, password: newPassword });
    } finally {
        if (created) expect((await request.delete(`/api/user/${id}`, { headers })).ok()).toBeTruthy();
        const ids = messages().map(message => message.ID);
        if (ids.length) mailpit('/messages', 'DELETE', { IDs: ids });
    }
});

test('Merkmal-Set erhält Produktmerkmale in Reihenfolge und bleibt nach Neuladen erhalten', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-FEATURE-${Date.now()}`; let id: string | undefined;
    try {
        await login(page); await page.evaluate(() => { location.hash = 'feature-sets'; });
        const list = page.getByRole('dialog', { name: 'Wesentliche Merkmale', exact: true });
        await list.getByRole('button', { name: 'Merkmal-Set anlegen', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'Merkmal-Set anlegen', exact: true });
        await create.getByRole('textbox', { name: 'Name:', exact: true }).fill(name);
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/product-feature-set') && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(saved.ok()).toBeTruthy(); id = saved.request().postDataJSON().id; await expect(create).not.toBeVisible();
        await list.getByRole('textbox', { name: 'Wesentliche Merkmale suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Merkmal-Set bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Merkmale', exact: true }).click();
        await editor.getByRole('button', { name: 'Merkmal hinzufügen', exact: true }).click();
        let add = page.getByRole('dialog', { name: 'Merkmal hinzufügen', exact: true });
        await add.getByRole('combobox', { name: 'Produktinformation:' }).click(); await page.getByRole('option', { name: 'Produktnummer', exact: true }).click(); await add.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
        await editor.getByRole('button', { name: 'Merkmal hinzufügen', exact: true }).click(); add = page.getByRole('dialog', { name: 'Merkmal hinzufügen', exact: true });
        await add.getByRole('combobox', { name: 'Typ:', exact: true }).click(); await page.getByRole('option', { name: 'Grundpreis', exact: true }).click(); await add.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
        const [updated] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/product-feature-set/${id}`) && response.request().method() === 'PATCH'), editor.getByRole('button', { name: 'Merkmale speichern', exact: true }).click()]);
        expect(updated.ok()).toBeTruthy(); const result = (await (await request.post('/api/search/product-feature-set', { headers, data: { ids: [id], limit: 1 } })).json()).data[0];
        expect(result.features.map(feature => [feature.type, feature.name, feature.position])).toEqual([['product', 'productNumber', 1], ['referencePrice', 'referencePrice', 2]]);
    } finally { if (id) expect((await request.delete(`/api/product-feature-set/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Länderabhängige Steuerregel wird im eigenen Steuersatz gespeichert', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const id = randomUUID().replaceAll('-', ''); const name = `EMZ-TAX-RULE-${Date.now()}`; let created = false;
    try {
        expect((await request.post('/api/tax', { headers, data: { id, name, taxRate: 20, position: 1 } })).ok()).toBeTruthy(); created = true;
        const country = (await (await request.post('/api/search/country', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'iso', value: 'DE' }] } })).json()).data[0];
        const type = (await (await request.post('/api/search/tax-rule-type', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'technicalName', value: 'entire_country' }] } })).json()).data[0];
        await login(page); await page.evaluate(() => { location.hash = 'taxes'; });
        const list = page.getByRole('dialog', { name: 'Steuersätze', exact: true }); await list.getByRole('textbox', { name: 'Steuersätze suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Steuersatz bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Länderregeln', exact: true }).click();
        await editor.getByRole('button', { name: 'Länderregel anlegen', exact: true }).click(); const rule = page.getByRole('dialog', { name: 'Länderregel anlegen', exact: true });
        await chooseReference(page, rule, 'Land:', country.name); await chooseReference(page, rule, 'Regeltyp:', type.typeName); await rule.getByRole('spinbutton', { name: 'Steuersatz (%):', exact: true }).fill('19');
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/tax-rule') && response.request().method() === 'POST'), rule.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(saved.ok(), (await saved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); await expect(rule).not.toBeVisible();
        const result = (await (await request.post('/api/search/tax-rule', { headers, data: { limit: 5, filter: [{ type: 'equals', field: 'taxId', value: id }] } })).json()).data;
        expect(result).toHaveLength(1); expect(result[0].countryId).toBe(country.id); expect(result[0].taxRate).toBe(19);
    } finally { if (created) {
        const rules = (await (await request.post('/api/search/tax-rule', { headers, data: { limit: 25, filter: [{ type: 'equals', field: 'taxId', value: id }] } })).json()).data;
        for (const rule of rules) expect((await request.delete(`/api/tax-rule/${rule.id}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/tax/${id}`, { headers })).ok()).toBeTruthy();
    } }
});

test('Suchkonfiguration speichert Stoppwörter und gewichtete Suchfelder für eine eigene Sprache', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const languageId = randomUUID().replaceAll('-', ''); const name = `EMZ-SEARCH-${Date.now()}`; let id: string | undefined; let languageCreated = false;
    try {
        const source = (await (await request.post('/api/search/language', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'parentId', value: null }] } })).json()).data[0];
        expect((await request.post('/api/language', { headers, data: { id: languageId, name, parentId: source.id, localeId: source.localeId } })).ok()).toBeTruthy(); languageCreated = true;
        await login(page); await page.evaluate(() => { location.hash = 'search-settings'; }); const list = page.getByRole('dialog', { name: 'Suchkonfiguration', exact: true });
        await list.getByRole('button', { name: 'Suchkonfiguration anlegen', exact: true }).click(); const create = page.getByRole('dialog', { name: 'Suchkonfiguration anlegen', exact: true });
        await chooseReference(page, create, 'Sprache:', name); await create.getByRole('textbox', { name: 'Ausgeschlossene Wörter (eines je Zeile):' }).fill('und\noder');
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/product-search-config') && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(saved.ok()).toBeTruthy(); id = saved.request().postDataJSON().id; await expect(create).not.toBeVisible();
        await list.getByRole('textbox', { name: 'Suchkonfiguration suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Suchkonfiguration bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Durchsuchbare Felder', exact: true }).click(); await editor.getByRole('button', { name: 'Suchfeld anlegen', exact: true }).click();
        const field = page.getByRole('dialog', { name: 'Suchfeld anlegen', exact: true }); await field.getByRole('combobox', { name: 'Feld:', exact: true }).click(); await page.getByRole('option', { name: 'Produktname', exact: true }).click(); await field.getByRole('spinbutton', { name: 'Gewichtung:', exact: true }).fill('700');
        const [fieldSaved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/product-search-config-field') && response.request().method() === 'POST'), field.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(fieldSaved.ok(), (await fieldSaved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        const result = (await (await request.post('/api/search/product-search-config', { headers, data: { ids: [id], limit: 1, associations: { configFields: {} } } })).json()).data[0];
        expect(result.excludedTerms).toEqual(['und', 'oder']); expect(result.configFields).toHaveLength(1); expect(result.configFields[0].ranking).toBe(700); expect(result.configFields[0].field).toBe('name');
    } finally {
        if (id) expect((await request.delete(`/api/product-search-config/${id}`, { headers })).ok()).toBeTruthy();
        if (languageCreated) expect((await request.delete(`/api/language/${languageId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Globale Suche findet ein eigenes Produkt und die weiteren Systemansichten laden', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const id = randomUUID().replaceAll('-', ''); const name = `EMZGLOBAL${Date.now()}`; let created = false;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
        const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
        expect((await request.post('/api/product', { headers, data: { id, name, productNumber: name, stock: 0, active: false, taxId: tax.id, price: [{ currencyId: currency.id, gross: 10, net: 10, linked: false }] } })).ok()).toBeTruthy(); created = true;
        await login(page); await page.getByRole('button', { name: 'Globale Suche', exact: true }).click(); const search = page.getByRole('dialog', { name: 'Globale Suche', exact: true });
        await search.getByRole('textbox', { name: 'Administration durchsuchen', exact: true }).fill(name); await search.getByRole('row').filter({ hasText: name }).dblclick();
        const product = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }); await expect(product.getByRole('textbox', { name: 'Produktname:', exact: true })).toHaveValue(name); await product.getByRole('button', { name: 'Abbrechen', exact: true }).click();
        await page.getByRole('button', { name: 'Benachrichtigungen', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Benachrichtigungen', exact: true })).toContainText('ungelesen');
        await page.evaluate(() => { location.hash = 'measurement'; }); const measurement = page.getByRole('dialog', { name: 'Maßsysteme', exact: true }); await expect(measurement.getByRole('combobox', { name: 'Maßsystem:', exact: true })).not.toHaveValue('');
        await page.evaluate(() => { location.hash = 'state-machines'; }); const states = page.getByRole('dialog', { name: 'Statusverwaltung', exact: true }); await states.getByRole('gridcell').first().dblclick();
        const state = page.getByRole('dialog', { name: 'Statusgruppe bearbeiten', exact: true }); await state.getByRole('tab', { name: 'Übergänge', exact: true }).click(); await expect(state.getByRole('gridcell').first()).toBeVisible();
        expect(errors).toEqual([]);
    } finally { if (created) expect((await request.delete(`/api/product/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Flow-Ablaufbaum verknüpft Status-, Dokument- und Zusatzfeldaktionen mit korrekter Konfiguration', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const id = randomUUID().replaceAll('-', ''); const setId = randomUUID().replaceAll('-', ''); const fieldId = randomUUID().replaceAll('-', '');
    const name = `EMZ-FLOW-ACTIONS-${Date.now()}`; const fieldName = `emz_flow_${Date.now()}`; let created = false; let fieldsCreated = false;
    try {
        expect((await request.post('/api/custom-field-set', { headers, data: { id: setId, name: fieldName, active: true, relations: [{ entityName: 'order' }], customFields: [{ id: fieldId, name: fieldName, type: 'text', active: true, config: { label: { 'de-DE': 'Flow-Testwert' }, componentName: 'sw-text-field' } }] } })).ok()).toBeTruthy(); fieldsCreated = true;
        expect((await request.post('/api/flow', { headers, data: { id, name, eventName: 'checkout.order.placed', active: false, priority: 1 } })).ok()).toBeTruthy(); created = true;
        const state = (await (await request.post('/api/search/state-machine-state', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'stateMachine.technicalName', value: 'order.state' }, { type: 'equals', field: 'technicalName', value: 'in_progress' }] } })).json()).data[0];
        const invoice = (await (await request.post('/api/search/document-type', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'technicalName', value: 'invoice' }] } })).json()).data[0];
        await login(page); await page.evaluate(() => { location.hash = 'flows'; }); const list = page.getByRole('dialog', { name: 'Flow Builder', exact: true });
        await list.getByRole('textbox', { name: 'Flow Builder suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick(); const flow = page.getByRole('dialog', { name: 'Flow bearbeiten', exact: true });
        await flow.getByRole('tab', { name: 'Ablaufbaum', exact: true }).click(); await flow.getByRole('button', { name: 'Aktion anhängen', exact: true }).click();
        async function selectAction(label) {
            const dialog = page.getByRole('dialog', { name: 'Aktion auswählen', exact: true }); await dialog.getByRole('combobox', { name: 'Aktion:', exact: true }).click(); await page.getByRole('option', { name: label, exact: true }).click(); await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
        }
        async function saveStep() {
            const step = page.getByRole('dialog', { name: 'Schritt anlegen', exact: true });
            const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/flow-sequence') && response.request().method() === 'POST'), step.getByRole('button', { name: 'Speichern', exact: true }).click()]);
            expect(response.ok(), (await response.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); await expect(step).not.toBeVisible();
        }
        await selectAction('Bestell-, Zahlungs- oder Lieferstatus ändern'); let step = page.getByRole('dialog', { name: 'Schritt anlegen', exact: true });
        await step.getByRole('combobox', { name: 'Bestellstatus:', exact: true }).click(); await page.getByRole('option', { name: state.name, exact: true }).click(); await saveStep();
        await flow.getByRole('row').filter({ hasText: 'Bestell-, Zahlungs- oder Lieferstatus ändern' }).click(); await flow.getByRole('button', { name: 'Aktion anhängen', exact: true }).click(); await selectAction('Dokumente erzeugen');
        step = page.getByRole('dialog', { name: 'Schritt anlegen', exact: true }); await step.getByRole('combobox', { name: 'Dokumenttypen', exact: false }).click(); await page.getByRole('option', { name: invoice.name, exact: true }).click(); await saveStep();
        await flow.getByRole('row').filter({ hasText: 'Dokumente erzeugen' }).click(); await flow.getByRole('button', { name: 'Aktion anhängen', exact: true }).click(); await selectAction('Bestellungs-Zusatzfeld ändern');
        const custom = page.getByRole('dialog', { name: 'Zusatzfeld auswählen', exact: true }); await chooseReference(page, custom, 'Zusatzfeld:', fieldName); await custom.getByRole('button', { name: 'Weiter', exact: true }).click();
        step = page.getByRole('dialog', { name: 'Schritt anlegen', exact: true }); await step.getByRole('textbox', { name: 'Wert:', exact: true }).fill('Flow funktioniert'); await saveStep();
        const stored = (await (await request.post('/api/search/flow', { headers, data: { ids: [id], limit: 1, associations: { sequences: { limit: 10 } } } })).json()).data[0];
        expect(stored.invalid).toBeFalsy(); expect(stored.active).toBeFalsy(); expect(stored.sequences).toHaveLength(3);
        const statusStep = stored.sequences.find(s => s.actionName === 'action.set.order.state'); const documentStep = stored.sequences.find(s => s.actionName === 'action.generate.document'); const customStep = stored.sequences.find(s => s.actionName === 'action.set.order.custom.field');
        expect(statusStep.config.order).toBe('in_progress'); expect(documentStep.parentId).toBe(statusStep.id); expect(documentStep.config.documentTypes).toEqual([{ documentType: 'invoice', documentRangerType: 'document_invoice' }]);
        expect(customStep.parentId).toBe(documentStep.id); expect(customStep.config).toMatchObject({ entity: 'order', customFieldId: fieldId, customFieldValue: 'Flow funktioniert', option: 'upsert' });
    } finally {
        if (created) expect((await request.delete(`/api/flow/${id}`, { headers })).ok()).toBeTruthy();
        if (fieldsCreated) expect((await request.delete(`/api/custom-field-set/${setId}`, { headers })).ok()).toBeTruthy();
    }
});

async function createTestSalesChannel(request, headers, name, typeId = undefined) {
    const id = randomUUID().replaceAll('-', '');
    const source = (await (await request.post('/api/search/sales-channel', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'type.iconName', value: 'regular-storefront' }] } })).json()).data[0]
        || (await (await request.post('/api/search/sales-channel', { headers, data: { limit: 1 } })).json()).data[0];
    const fields = ['typeId', 'languageId', 'currencyId', 'customerGroupId', 'countryId', 'paymentMethodId', 'shippingMethodId', 'navigationCategoryId'];
    const accessKey = (await (await request.get('/api/_action/access-key/sales-channel', { headers })).json()).accessKey;
    expect((await request.post('/api/sales-channel', { headers, data: { ...Object.fromEntries(fields.map(key => [key, source[key]])), ...(typeId ? { typeId } : {}), id, name, accessKey, active: false, countries: [{ id: source.countryId }], currencies: [{ id: source.currencyId }], languages: [{ id: source.languageId }] } })).ok()).toBeTruthy();
    return id;
}

test('Captcha-Konfiguration speichert nur die eigene Verkaufskanal-Überschreibung', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-CAPTCHA-${Date.now()}`; const id = await createTestSalesChannel(request, headers, name);
    const global = await (await request.get('/api/_action/system-config?domain=core.basicInformation', { headers })).json();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await login(page); await page.evaluate(() => { location.hash = 'config-basicInformation'; }); const panel = page.getByRole('dialog', { name: 'Stammdaten', exact: true });
        await chooseReference(page, panel, 'Verkaufskanal (leer = global):', name);
        await expect(panel.getByRole('checkbox', { name: /Honeypot aktiv/ })).toBeVisible();
        await expect(panel.getByRole('checkbox', { name: /Globalen Wert verwenden:.*captcha/i })).toBeChecked();
        await panel.getByRole('checkbox', { name: /Globalen Wert verwenden:.*captcha/i }).uncheck();
        await panel.getByRole('checkbox', { name: /Honeypot aktiv/ }).check();
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/system-config/batch') && response.request().method() === 'POST'), panel.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(saved.ok()).toBeTruthy(); const scoped = await (await request.get(`/api/_action/system-config?domain=core.basicInformation&salesChannelId=${id}`, { headers })).json();
        expect(scoped['core.basicInformation.activeCaptchasV2'].honeypot.isActive).toBe(true);
        const after = await (await request.get('/api/_action/system-config?domain=core.basicInformation', { headers })).json();
        // Compare privately; never include captcha keys in assertion output.
        expect(JSON.stringify(after) === JSON.stringify(global), 'Globale Konfiguration bleibt unverändert').toBe(true); expect(errors).toEqual([]);
    } finally { expect((await request.delete(`/api/sales-channel/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Theme-Zuweisung kompiliert eine eigene Theme-Kopie für einen Testverkaufskanal', async ({ page, request }) => {
    test.setTimeout(120000);
    const headers = await integrationHeaders(request); const name = `EMZ-THEME-ASSIGN-${Date.now()}`; const channelId = await createTestSalesChannel(request, headers, name); const themeId = randomUUID().replaceAll('-', ''); let created = false;
    try {
        const parent = (await (await request.post('/api/search/theme', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'technicalName', value: 'Storefront' }] } })).json()).data[0];
        expect((await request.post('/api/theme', { headers, data: { id: themeId, name, author: 'EMZ Test', active: true, parentThemeId: parent.id } })).ok()).toBeTruthy(); created = true;
        await login(page); await page.evaluate(() => { location.hash = 'sales-channels'; }); const list = page.getByRole('dialog', { name: 'Verkaufskanäle', exact: true });
        await list.getByRole('textbox', { name: 'Verkaufskanäle suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick(); const channel = page.getByRole('dialog', { name: 'Verkaufskanal bearbeiten', exact: true });
        await channel.getByRole('tab', { name: 'Theme', exact: true }).click(); await chooseReference(page, channel, 'Theme:', name); await channel.getByRole('button', { name: 'Theme zuweisen', exact: true }).click();
        const [assigned] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/_action/theme/${themeId}/assign/${channelId}`) && response.request().method() === 'POST'), page.getByRole('button', { name: 'Ja', exact: true }).click()]);
        expect(assigned.ok(), (await assigned.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        await expect.poll(async () => (await (await request.post('/api/search/theme', { headers, data: { ids: [themeId], limit: 1, associations: { salesChannels: { limit: 1 } } } })).json()).data[0].salesChannels.some(channel => channel.id === channelId), { timeout: 90000 }).toBe(true);
        await channel.getByRole('button', { name: 'Zuweisung aktualisieren', exact: true }).click(); await expect(channel).toContainText(`Aktuelles Theme: ${name}`);
    } finally {
        expect((await request.delete(`/api/sales-channel/${channelId}`, { headers })).ok()).toBeTruthy();
        if (created) expect((await request.delete(`/api/theme/${themeId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Erweiterungsverwaltung lädt installierte Plugins und ihre Details', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page); await page.evaluate(() => { location.hash = 'extensions'; }); const extensions = page.getByRole('dialog', { name: 'Erweiterungen', exact: true });
    await extensions.getByRole('textbox', { name: 'Erweiterungen suchen', exact: true }).fill('EmzExtAdministration');
    await extensions.getByRole('row').filter({ hasText: 'EmzExtAdministration' }).click();
    await expect(extensions.getByRole('button', { name: 'Installieren', exact: true })).toBeDisabled(); await expect(extensions.getByRole('button', { name: 'Deaktivieren', exact: true })).toBeEnabled();
    await extensions.getByRole('button', { name: 'Details', exact: true }).click(); await expect(page.getByRole('dialog', { name: /^Erweiterung:/ })).toContainText('GPL');
    expect(errors).toEqual([]);
});

test('Produktkopie erhält Varianten und Massenbearbeitung ändert nur markierte Werte', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const prefix = `EMZ-BULK-${Date.now()}`; const ids = [randomUUID().replaceAll('-', ''), randomUUID().replaceAll('-', '')]; const variantId = randomUUID().replaceAll('-', ''); let duplicateId: string | undefined;
    const created: string[] = [];
    try {
        const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
        const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'taxRate', value: 19 }] } })).json()).data[0];
        for (const [index, id] of ids.entries()) {
            expect((await request.post('/api/product', { headers, data: { id, name: `${prefix} ${index}`, productNumber: `${prefix}-${index}`, stock: 3 + index, active: false, description: 'Unveränderte Beschreibung', taxId: tax.id,
                price: [{ currencyId: currency.id, gross: 59.5, net: 50, linked: true, listPrice: { gross: 71.4, net: 60, linked: true } }] } })).ok()).toBeTruthy(); created.push(id);
        }
        expect((await request.post('/api/product', { headers, data: { id: variantId, parentId: ids[0], productNumber: `${prefix}-variant`, stock: 2 } })).ok()).toBeTruthy();
        await login(page); await page.getByRole('button', { name: 'Artikel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Produkte', exact: true }).click(); const list = page.getByRole('dialog', { name: 'Produkte', exact: true });
        await list.getByRole('textbox', { name: 'Produkte suchen', exact: true }).fill(prefix); await list.getByRole('gridcell', { name: `${prefix} 0`, exact: true }).click();
        await list.getByRole('button', { name: 'Duplizieren', exact: true }).click(); const clone = page.getByRole('dialog', { name: 'Produkt duplizieren', exact: true });
        await clone.getByRole('textbox', { name: 'Neue Artikelnummer:', exact: true }).fill(`${prefix}-copy`);
        const [copied] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/_action/clone/product/${ids[0]}`)), clone.getByRole('button', { name: 'Duplizieren', exact: true }).click()]);
        expect(copied.ok(), (await copied.json()).errors?.[0]?.detail).toBeTruthy(); duplicateId = (await copied.json()).id; await expect(clone).not.toBeVisible();
        const duplicate = (await (await request.post('/api/search/product', { headers, data: { ids: [duplicateId], limit: 1, associations: { children: { limit: 5 } } } })).json()).data[0];
        expect(duplicate.children).toHaveLength(1); expect(duplicate.active).toBe(false); expect(duplicate.children[0].active).toBe(false); expect(duplicate.children[0].productNumber).toBe(`${prefix}-copy.1`);
        await list.getByRole('gridcell', { name: `${prefix} 0`, exact: true }).click(); await list.getByRole('gridcell', { name: `${prefix} 1`, exact: true }).click({ modifiers: ['Control'] });
        await list.getByRole('button', { name: 'Gemeinsam bearbeiten', exact: true }).click(); const bulk = page.getByRole('dialog', { name: 'Produkte gemeinsam bearbeiten', exact: true });
        await expect(bulk).toContainText('2 ausgewählte Produkte'); await bulk.getByRole('checkbox', { name: 'Ändern: Bestand', exact: true }).check(); await bulk.getByRole('spinbutton', { name: 'Bestand:', exact: true }).fill('7');
        await bulk.getByRole('tab', { name: 'Preise', exact: true }).click();
        await bulk.getByRole('checkbox', { name: 'Systemwährungspreise ändern', exact: true }).check(); await bulk.getByRole('spinbutton', { name: /^Wert \(/ }).fill('119');
        await bulk.getByRole('button', { name: 'Änderungen anwenden', exact: true }).click(); const [updated] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/sync') && response.request().method() === 'POST'), page.getByRole('button', { name: 'Ja', exact: true }).click()]);
        expect(updated.ok(), (await updated.json()).errors?.[0]?.detail).toBeTruthy(); await expect(bulk).not.toBeVisible();
        const records = (await (await request.post('/api/search/product', { headers, data: { ids, limit: 2 } })).json()).data;
        for (const record of records) { expect(record.stock).toBe(7); expect(record.description).toBe('Unveränderte Beschreibung'); expect(record.price[0].gross).toBe(119); expect(record.price[0].net).toBe(100); expect(record.price[0].listPrice.gross).toBe(71.4); }
        const copy = (await (await request.post('/api/search/product', { headers, data: { ids: [duplicateId], limit: 1 } })).json()).data[0]; expect(copy.stock).toBe(3); expect(copy.price[0].gross).toBe(59.5);
    } finally {
        if (duplicateId) expect((await request.delete(`/api/product/${duplicateId}`, { headers })).ok()).toBeTruthy();
        for (const id of created) expect((await request.delete(`/api/product/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Mehrere Medien hochladen und verschieben; Ordner-Konfiguration löst Vererbung ohne Änderung am Elternordner', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-MEDIA-BATCH-${Date.now()}`; const parentId = randomUUID().replaceAll('-', ''); const childId = randomUUID().replaceAll('-', ''); const configId = randomUUID().replaceAll('-', '');
    let parentCreated = false; let childCreated = false; let ownConfigId: string | undefined;
    const mediaIds: string[] = [];
    try {
        expect((await request.post('/api/media-folder', { headers, data: { id: parentId, name: `${name} Parent`, useParentConfiguration: false, configuration: { id: configId, createThumbnails: true, keepAspectRatio: true, thumbnailQuality: 80 } } })).ok()).toBeTruthy(); parentCreated = true;
        expect((await request.post('/api/media-folder', { headers, data: { id: childId, name: `${name} Child`, parentId, useParentConfiguration: true, configurationId: configId } })).ok()).toBeTruthy(); childCreated = true;
        await login(page); await page.evaluate(() => { location.hash = 'media-folders'; }); const folders = page.getByRole('dialog', { name: 'Medienordner', exact: true });
        await folders.getByRole('textbox', { name: 'Medienordner suchen' }).fill(`${name} Child`); await folders.getByRole('row').filter({ hasText: `${name} Child` }).dblclick(); const folder = page.getByRole('dialog', { name: 'Medienordner bearbeiten', exact: true });
        await folder.getByRole('tab', { name: 'Ordner-Einstellungen', exact: true }).click(); const inherit = folder.getByRole('checkbox', { name: 'Einstellungen des übergeordneten Ordners verwenden', exact: true }); await expect(inherit).toBeChecked(); await inherit.uncheck();
        await folder.getByRole('spinbutton', { name: 'Bildqualität (%):', exact: true }).fill('65');
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/media-folder/${childId}`) && response.request().method() === 'PATCH'), folder.getByRole('button', { name: 'Ordner-Einstellungen speichern', exact: true }).click()]);
        expect(saved.ok(), (await saved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); ownConfigId = saved.request().postDataJSON().configuration.id;
        const parentConfig = (await (await request.post('/api/search/media-folder-configuration', { headers, data: { ids: [configId], limit: 1 } })).json()).data[0]; expect(parentConfig.thumbnailQuality).toBe(80);
        const child = (await (await request.post('/api/search/media-folder', { headers, data: { ids: [childId], limit: 1, associations: { configuration: {} } } })).json()).data[0]; expect(child.configurationId).toBe(ownConfigId); expect(child.configuration.thumbnailQuality).toBe(65); expect(child.useParentConfiguration).toBe(false);
        await expect(inherit).not.toBeChecked(); await folder.getByRole('button', { name: 'Abbrechen', exact: true }).click();
        await page.evaluate(() => { location.hash = 'media'; }); const media = page.getByRole('dialog', { name: 'Medien', exact: true }); await media.getByRole('button', { name: 'Datei hochladen', exact: true }).click(); const upload = page.getByRole('dialog', { name: 'Datei hochladen', exact: true });
        const buffer = await readFile('../../vendor/shopware/administration/Resources/public/administration/static/img/favicon/favicon-32x32.png');
        await upload.locator('input[type=file]').setInputFiles([0, 1].map(index => ({ name: `${name}-${index}.png`, mimeType: 'image/png', buffer })));
        await chooseReference(page, upload, 'Ordner:', `${name} Parent`); await upload.getByRole('button', { name: 'Hochladen', exact: true }).click(); await expect(upload).not.toBeVisible();
        const records = (await (await request.post('/api/search/media', { headers, data: { limit: 10, filter: [{ type: 'contains', field: 'fileName', value: name }] } })).json()).data; mediaIds.push(...records.map(row => row.id)); expect(records).toHaveLength(2); expect(records.every(row => row.hasFile && row.mediaFolderId === parentId)).toBe(true);
        await media.getByRole('textbox', { name: 'Medien suchen', exact: true }).fill(name); await media.getByRole('gridcell', { name: `${name}-0`, exact: true }).click(); await media.getByRole('gridcell', { name: `${name}-1`, exact: true }).click({ modifiers: ['Control'] });
        await media.getByRole('button', { name: 'Verschieben', exact: true }).click(); const move = page.getByRole('dialog', { name: 'Medien verschieben', exact: true }); await expect(move).toContainText('2 ausgewählte Dateien'); await chooseReference(page, move, 'Zielordner (leer = Hauptverzeichnis):', `${name} Child`);
        await move.getByRole('button', { name: 'Verschieben', exact: true }).click(); await expect(move).not.toBeVisible();
        const moved = (await (await request.post('/api/search/media', { headers, data: { ids: mediaIds, limit: 2 } })).json()).data; expect(moved.every(row => row.mediaFolderId === childId)).toBe(true);
        await page.evaluate(() => { location.hash = 'media-folders'; });
        await folders.getByRole('row').filter({ hasText: `${name} Child` }).click(); await folders.getByRole('button', { name: 'Ordner auflösen', exact: true }).click();
        const [dissolved] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/_action/media-folder/${childId}/dissolve`)), page.getByRole('alertdialog').getByRole('button', { name: 'Ja', exact: true }).click()]);
        expect(dissolved.ok(), (await dissolved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); childCreated = false; ownConfigId = undefined;
        const retained = (await (await request.post('/api/search/media', { headers, data: { ids: mediaIds, limit: 2 } })).json()).data;
        expect(retained).toHaveLength(2); expect(retained.every(row => row.mediaFolderId === parentId && row.hasFile)).toBe(true);
    } finally {
        if (!mediaIds.length) mediaIds.push(...(await (await request.post('/api/search/media', { headers, data: { limit: 10, filter: [{ type: 'contains', field: 'fileName', value: name }] } })).json()).data.map(row => row.id));
        for (const id of mediaIds) expect((await request.delete(`/api/media/${id}`, { headers })).ok()).toBeTruthy();
        if (childCreated) expect((await request.delete(`/api/media-folder/${childId}`, { headers })).ok()).toBeTruthy();
        if (parentCreated) expect((await request.delete(`/api/media-folder/${parentId}`, { headers })).ok()).toBeTruthy();
        if (ownConfigId) expect((await request.delete(`/api/media-folder-configuration/${ownConfigId}`, { headers })).ok()).toBeTruthy();
        if (parentCreated) expect((await request.delete(`/api/media-folder-configuration/${configId}`, { headers })).ok()).toBeTruthy();
    }
});

test('CMS-Katalog speichert alle Standardblöcke; Gestaltung sortiert, verknüpft Inhalte und isoliert die Vorschau', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-CMS-CATALOG-${Date.now()}`; const ids: string[] = [];
    const sectionA = randomUUID().replaceAll('-', ''); const sectionB = randomUUID().replaceAll('-', ''); const slotId = randomUUID().replaceAll('-', '');
    const categoryId = randomUUID().replaceAll('-', ''); const pageId = randomUUID().replaceAll('-', '');
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        for (const type of ['page', 'product_list', 'product_detail']) {
            const id = randomUUID().replaceAll('-', '');
            const blocks = cmsBlocks.filter(block => (block.allowedPageTypes?.[0] || 'page') === type).map((block, position) => ({
                id: randomUUID().replaceAll('-', ''), type: block.name, position, sectionPosition: 'main', ...block.defaults, slots: blockSlots(block.name, type),
            }));
            const result = await request.post('/api/cms-page', { headers, data: { id, name: `${name}-${type}`, type, sections: [{ type: 'default', position: 0, blocks }] } });
            expect(result.ok(), (await result.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); ids.push(id);
        }
        expect((await request.post('/api/category', { headers, data: { id: categoryId, name: `${name} Kategorie`, active: false } })).ok()).toBeTruthy();
        const created = await request.post('/api/cms-page', { headers, data: { id: pageId, name, type: 'product_list', sections: [
            { id: sectionA, name: 'Erster Abschnitt', position: 0, type: 'default', blocks: [{ id: randomUUID().replaceAll('-', ''), name: 'Vorschautext', type: 'text', position: 0, sectionPosition: 'main', slots: [
                { id: slotId, slot: 'content', type: 'html', config: { content: { source: 'static', value: '<h2>Sichere CMS-Vorschau</h2><script>parent.document.body.dataset.cmsExecuted="yes"</script><img src=x onerror="parent.document.body.dataset.cmsExecuted=\'yes\'">' } } },
            ] }] }, { id: sectionB, name: 'Zweiter Abschnitt', position: 1, type: 'default' },
        ] } }); expect(created.ok()).toBeTruthy(); ids.push(pageId);
        await login(page); await page.evaluate(() => { location.hash = 'cms'; }); const list = page.getByRole('dialog', { name: 'Erlebniswelten', exact: true });
        await list.getByRole('textbox', { name: 'Erlebniswelten suchen' }).fill(name); await list.getByRole('gridcell', { name, exact: true }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Erlebniswelt bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Gestaltung', exact: true }).click();
        const preview = editor.frameLocator('iframe[title="Layout-Vorschau"]'); await expect(preview.getByRole('heading', { name: 'Sichere CMS-Vorschau' })).toBeVisible();
        expect(await preview.locator('script, img[onerror]').count()).toBe(0); expect(await page.locator('body').getAttribute('data-cms-executed')).toBeNull();
        await editor.getByRole('row').filter({ hasText: 'Zweiter Abschnitt' }).click(); const [sorted] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/api/_action/sync') && response.request().postData()?.includes('cms-order')),
            editor.getByRole('button', { name: 'Nach oben', exact: true }).click(),
        ]); expect(sorted.ok()).toBeTruthy();
        const sections = (await (await request.post('/api/search/cms-section', { headers, data: { ids: [sectionA, sectionB], limit: 2, sort: [{ field: 'position', order: 'ASC' }] } })).json()).data;
        expect(sections.map(section => section.id)).toEqual([sectionB, sectionA]);
        await editor.getByRole('row').filter({ hasText: 'content: HTML' }).dblclick(); const element = page.getByRole('dialog', { name: 'Element bearbeiten', exact: true });
        await element.getByRole('combobox', { name: 'Quelle: Text (HTML):', exact: true }).click(); await page.getByRole('option', { name: 'Dynamische Verknüpfung', exact: true }).click();
        await element.getByRole('combobox', { name: 'Verknüpftes Feld:', exact: true }).fill('category.name'); await element.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(element).not.toBeVisible();
        const slot = (await (await request.post('/api/search/cms-slot', { headers, data: { ids: [slotId], limit: 1 } })).json()).data[0]; expect(slot.config.content).toEqual({ source: 'mapped', value: 'category.name' });
        await chooseReference(page, editor, 'Vorschaukategorie:', `${name} Kategorie`); await editor.getByRole('button', { name: 'Vorschau laden', exact: true }).click(); await expect(preview.getByText(`${name} Kategorie`, { exact: true })).toBeVisible();
        await editor.getByRole('row').filter({ hasText: 'Zweiter Abschnitt' }).click(); await editor.getByRole('button', { name: 'Block hinzufügen', exact: true }).click();
        const block = page.getByRole('dialog', { name: 'Block anlegen', exact: true }); await block.getByRole('textbox', { name: 'Name:', exact: true }).fill('Lokales Video');
        await block.getByRole('combobox', { name: 'Blocktyp:', exact: true }).click(); await page.getByRole('option', { name: 'Video', exact: true }).click();
        await block.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(block).not.toBeVisible(); await expect(editor.getByRole('row').filter({ hasText: 'video: Video' })).toBeVisible();
        await editor.getByRole('row').filter({ hasText: 'video: Video' }).dblclick(); await expect(element.getByRole('checkbox', { name: 'Stumm:', exact: true })).toBeChecked();
        await element.getByRole('checkbox', { name: 'Wiederholen:', exact: true }).check(); await element.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(element).not.toBeVisible();
        const video = (await (await request.post('/api/search/cms-slot', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'block.section.pageId', value: pageId }, { type: 'equals', field: 'type', value: 'video' }] } })).json()).data[0];
        expect(video.config.loop.value).toBe(true); expect(video.config.muted.value).toBe(true); expect(errors).toEqual([]);
    } finally {
        for (const id of ids) expect((await request.delete(`/api/cms-page/${id}`, { headers })).ok()).toBeTruthy();
        await request.delete(`/api/category/${categoryId}`, { headers });
    }
});

test('Geschützte CMS-Standardseite lässt sich als vollständig bearbeitbare Kopie anlegen', async ({ page, request }) => {
    const headers = await integrationHeaders(request); let id: string | undefined;
    const original = (await (await request.post('/api/search/cms-page', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'locked', value: true }] } })).json()).data[0];
    expect(original).toBeTruthy(); const name = `EMZ-CMS-COPY-${Date.now()}`;
    try {
        await login(page); await page.evaluate(() => { location.hash = 'cms'; }); const list = page.getByRole('dialog', { name: 'Erlebniswelten', exact: true });
        await list.getByRole('textbox', { name: 'Erlebniswelten suchen' }).fill(original.name); await list.getByRole('gridcell', { name: original.name, exact: true }).click();
        await list.getByRole('button', { name: 'Duplizieren', exact: true }).click(); const prompt = page.getByRole('alertdialog', { name: 'Kopie anlegen', exact: true });
        await prompt.getByRole('textbox').fill(name); const [response] = await Promise.all([page.waitForResponse(response => response.url().includes(`/_action/clone/cms-page/${original.id}`)), prompt.getByRole('button', { name: 'OK', exact: true }).click()]);
        expect(response.ok()).toBeTruthy(); id = (await response.json()).id;
        const editor = page.getByRole('dialog', { name: 'Erlebniswelt bearbeiten', exact: true }); await expect(editor.getByRole('button', { name: 'Speichern', exact: true })).toBeEnabled();
        const copy = (await (await request.post('/api/search/cms-page', { headers, data: { ids: [id], limit: 1 } })).json()).data[0]; expect(copy.locked).toBeFalsy(); expect(copy.name).toBe(name);
        const copiedSections = (await (await request.post('/api/search/cms-section', { headers, data: { limit: 100, filter: [{ type: 'equals', field: 'pageId', value: id }] } })).json()).data;
        const copiedSlots = (await (await request.post('/api/search/cms-slot', { headers, data: { limit: 100, filter: [{ type: 'equals', field: 'block.section.pageId', value: id }] } })).json()).data;
        expect(copiedSections.length).toBeGreaterThan(0); expect(copiedSlots.length).toBeGreaterThan(0); expect(copiedSections.some(section => section.locked)).toBeFalsy(); expect(copiedSlots.some(slot => slot.locked)).toBeFalsy();
        const unchanged = (await (await request.post('/api/search/cms-page', { headers, data: { ids: [original.id], limit: 1 } })).json()).data[0]; expect(unchanged.name).toBe(original.name); expect(unchanged.locked).toBeTruthy();
    } finally { if (id) expect((await request.delete(`/api/cms-page/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('CMS wechselt den Elementtyp, speichert Galerien und Übersetzungen und zeigt dynamische Produkte', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', '');
    const name = 'EMZ-CMS-DETAIL-' + Date.now(); const pageId = uid(); const slotId = uid(); const sliderId = uid(); const mediaId = uid(); const streamId = uid(); const productId = uid(); const languageId = uid(); const created: [string, string][] = [];
    const first = async (entity, filter = []) => (await (await request.post('/api/search/' + entity, { headers, data: { limit: 1, filter } })).json()).data[0];
    const sourceLanguage = await first('language', [{ type: 'equals', field: 'parentId', value: null }]); const tax = await first('tax'); const currency = await first('currency', [{ type: 'equals', field: 'factor', value: 1 }]);
    const readSlot = async (id, language?) => (await (await request.post('/api/search/cms-slot', { headers: { ...headers, ...(language ? { 'sw-language-id': language } : {}) }, data: { ids: [id], limit: 1 } })).json()).data[0];
    try {
        for (const [entity, data] of [
            ['language', { id: languageId, name, parentId: sourceLanguage.id, localeId: sourceLanguage.localeId }],
            ['media', { id: mediaId }],
            ['product', { id: productId, name, productNumber: name, active: false, stock: 1, taxId: tax.id, price: [{ currencyId: currency.id, gross: 10, net: 10, linked: false }] }],
            ['product-stream', { id: streamId, name, filters: [{ type: 'multi', operator: 'AND', position: 0, queries: [{ type: 'equals', field: 'productNumber', value: name, position: 0 }] }] }],
            ['cms-page', { id: pageId, name, type: 'page', sections: [{ type: 'default', position: 0, blocks: [
                { name: 'Galerie bearbeiten', type: 'text', position: 0, sectionPosition: 'main', slots: [{ id: slotId, slot: 'content', type: 'text', config: { content: { source: 'static', value: 'Alter Text' } } }] },
                { type: 'product-slider', position: 1, sectionPosition: 'main', slots: [{ id: sliderId, slot: 'productSlider', type: 'product-slider', config: { products: { source: 'product_stream', value: streamId }, title: { source: 'static', value: 'Treffer aus Produktgruppe' } } }] },
            ] }] }],
        ] as [string, any][]) {
            const response = await request.post('/api/' + entity, { headers, data }); expect(response.ok(), (await response.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); created.push([entity, data.id]);
        }
        const buffer = await readFile('../../vendor/shopware/administration/Resources/public/administration/static/img/favicon/favicon-32x32.png');
        expect((await request.post('/api/_action/media/' + mediaId + '/upload?extension=png&fileName=' + name, { headers: { ...headers, 'Content-Type': 'image/png' }, data: buffer })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'cms'; }); const list = page.getByRole('dialog', { name: 'Erlebniswelten', exact: true });
        await list.getByRole('textbox', { name: 'Erlebniswelten suchen', exact: true }).fill(name); await list.getByRole('gridcell', { name, exact: true }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Erlebniswelt bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Gestaltung', exact: true }).click();
        await expect(editor.frameLocator('iframe[title="Layout-Vorschau"]').getByText(name, { exact: true }).first()).toBeVisible();
        await editor.getByRole('row').filter({ hasText: 'content: Text' }).dblclick(); const element = page.getByRole('dialog', { name: 'Element bearbeiten', exact: true });
        await element.getByRole('combobox', { name: 'Elementtyp:', exact: true }).click(); await page.getByRole('option', { name: 'Galerie', exact: true }).click();
        await page.getByRole('alertdialog', { name: 'Elementtyp wechseln?', exact: true }).getByRole('button', { name: 'Ja', exact: true }).click();
        await element.getByRole('button', { name: 'Bild hinzufügen', exact: true }).click(); const picture = page.getByRole('dialog', { name: 'Galeriebild bearbeiten', exact: true });
        await chooseReference(page, picture, 'Bild:', name); await picture.getByRole('textbox', { name: 'Link:', exact: true }).fill('/galerie-original');
        await picture.getByRole('checkbox', { name: 'In neuem Tab öffnen:', exact: true }).check(); await picture.getByRole('button', { name: 'Übernehmen', exact: true }).click();
        await element.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(element).not.toBeVisible();
        const original = await readSlot(slotId); expect(original.type).toBe('image-gallery'); expect(original.config.sliderItems.value).toEqual([{ mediaId, url: '/galerie-original', newTab: true }]);
        expect(original.config.content).toBeUndefined();
        await editor.getByRole('row').filter({ hasText: 'content: Galerie' }).dblclick();
        await chooseReference(page, element, 'Sprache:', name); await element.getByRole('button', { name: 'Sprache laden', exact: true }).click();
        await element.getByRole('row').filter({ hasText: '/galerie-original' }).click(); await element.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
        await picture.getByRole('textbox', { name: 'Link:', exact: true }).fill('/galerie-uebersetzt'); await picture.getByRole('button', { name: 'Übernehmen', exact: true }).click();
        await element.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(element).not.toBeVisible();
        expect((await readSlot(slotId, languageId)).config.sliderItems.value[0].url).toBe('/galerie-uebersetzt'); expect((await readSlot(slotId)).config.sliderItems.value[0].url).toBe('/galerie-original');
    } finally { for (const [entity, id] of created.reverse()) expect((await request.delete('/api/' + entity + '/' + id, { headers })).ok()).toBeTruthy(); }
});

test('Individuelle Layout-Inhalte für Produkt, Kategorie, Landingpage und Startseite verändern keine Vorlage', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const name = `EMZ-CMS-OWNER-${Date.now()}`;
    const fixtures: { entity: string; id: string; pageId: string; slotId: string; route: string; title: string; editor: string; field: string }[] = [];
    const salesChannel = (await (await request.post('/api/search/sales-channel', { headers, data: { limit: 1 } })).json()).data[0];
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        for (const [entity, route, title, editor, type] of [['product', 'products', 'Produkte', 'Produkt bearbeiten', 'product_detail'], ['category', 'categories', 'Kategorien', 'Kategorie bearbeiten', 'product_list'],
            ['landing-page', 'landing-pages', 'Landingpages', 'Landingpage bearbeiten', 'landingpage'], ['sales-channel', 'sales-channels', 'Verkaufskanäle', 'Verkaufskanal bearbeiten', 'page']]) {
            const pageId = uid(); const slotId = uid(); const field = entity === 'sales-channel' ? 'homeSlotConfig' : 'slotConfig';
            expect((await request.post('/api/cms-page', { headers, data: { id: pageId, name: `${name}-${entity}`, type, sections: [{ type: 'default', position: 0, blocks: [{ type: 'text', position: 0, sectionPosition: 'main', slots: [{ id: slotId, type: 'text', slot: 'content', config: { content: { source: 'static', value: '<h2>Gemeinsame Vorlage</h2>' } } }] }] }] } })).ok()).toBeTruthy();
            const id = entity === 'sales-channel' ? await createTestSalesChannel(request, headers, name) : uid();
            fixtures.push({ entity, id, pageId, slotId, route, title, editor, field });
            const data = entity === 'sales-channel' ? { homeCmsPageId: pageId } : { id, name, cmsPageId: pageId, active: false,
                ...(entity === 'product' ? { productNumber: name, stock: 0, taxId: tax.id, price: [{ currencyId: currency.id, gross: 11.9, net: 10, linked: true }] } : entity === 'landing-page' ? { url: name.toLowerCase(), salesChannels: [{ id: salesChannel.id }] } : {}) };
            const saved = entity === 'sales-channel' ? await request.patch(`/api/${entity}/${id}`, { headers, data }) : await request.post(`/api/${entity}`, { headers, data });
            const error = (await saved.json().catch(() => ({}))).errors?.[0];
            expect(saved.ok(), `${entity}: ${error?.detail} ${error?.source?.pointer}`).toBeTruthy();
        }
        await login(page);
        for (const fixture of fixtures) {
            await page.evaluate(id => { location.hash = id; }, fixture.route); const list = page.getByRole('dialog', { name: fixture.title, exact: true });
            await list.getByRole('textbox', { name: `${fixture.title} suchen`, exact: true }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
            const editor = page.getByRole('dialog', { name: fixture.editor, exact: true }); await editor.getByRole('tab', { name: 'Layout-Inhalte', exact: true }).click();
            await editor.getByRole('row').filter({ hasText: 'Layout-Vorgabe' }).dblclick(); const content = page.getByRole('dialog', { name: 'Inhalt überschreiben', exact: true });
            await expect(content.getByRole('textbox', { name: 'Text (HTML):', exact: true })).toHaveValue('<h2>Gemeinsame Vorlage</h2>');
            await content.getByRole('textbox', { name: 'Text (HTML):', exact: true }).fill(`<h2>Eigener Inhalt ${fixture.entity}</h2>`);
            const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/${fixture.entity}/${fixture.id}`) && response.request().method() === 'PATCH'), content.getByRole('button', { name: 'Speichern', exact: true }).click()]);
            expect(saved.ok(), (await saved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); await expect(content).not.toBeVisible();
            await expect(editor.getByRole('row').filter({ hasText: 'Individuell' })).toBeVisible();
            await editor.getByRole('button', { name: 'Vorschau', exact: true }).click(); const preview = page.getByRole('dialog', { name: 'Inhaltsvorschau', exact: true });
            await expect(preview.frameLocator('iframe').getByRole('heading', { name: `Eigener Inhalt ${fixture.entity}`, exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(preview).not.toBeVisible();
            const original = (await (await request.post('/api/search/cms-slot', { headers, data: { ids: [fixture.slotId], limit: 1 } })).json()).data[0]; expect(original.config.content.value).toBe('<h2>Gemeinsame Vorlage</h2>');
            await editor.getByRole('row').filter({ hasText: 'Individuell' }).click(); await editor.getByRole('button', { name: 'Layout-Vorgabe verwenden', exact: true }).click();
            await page.getByRole('alertdialog', { name: 'Individuellen Inhalt zurücksetzen?', exact: true }).getByRole('button', { name: 'Ja', exact: true }).click();
            await expect(editor.getByRole('row').filter({ hasText: 'Layout-Vorgabe' })).toBeVisible();
            const owner = (await (await request.post(`/api/search/${fixture.entity}`, { headers, data: { ids: [fixture.id], limit: 1 } })).json()).data[0]; expect(owner[fixture.field]).toBeNull();
            await editor.getByRole('button', { name: 'Abbrechen', exact: true }).click(); await expect(editor).not.toBeVisible();
        }
        expect(errors).toEqual([]);
    } finally {
        for (const fixture of fixtures.reverse()) { await request.delete(`/api/${fixture.entity}/${fixture.id}`, { headers }); expect((await request.delete(`/api/cms-page/${fixture.pageId}`, { headers })).ok()).toBeTruthy(); }
    }
});

test('Varianten können Stammdaten und Preise gezielt erben oder mit gleichem Wert überschreiben', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const id = randomUUID().replaceAll('-', ''); const childId = randomUUID().replaceAll('-', ''); const name = `EMZ-INHERIT-${Date.now()}`;
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'taxRate', value: 19 }] } })).json()).data[0];
    expect((await request.post('/api/product', { headers, data: { id, name, productNumber: name, stock: 100, active: false, shippingFree: false, description: 'Beschreibung des Hauptprodukts', taxId: tax.id,
        price: [{ currencyId: currency.id, gross: 59.5, net: 50, linked: true, listPrice: { gross: 71.4, net: 60, linked: true } }], children: [{ id: childId, name: `${name} Variante`, productNumber: `${name}.1`, stock: 4, shippingFree: true, price: [{ currencyId: currency.id, gross: 11.9, net: 10, linked: true }] }] } })).ok()).toBeTruthy();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await login(page); await page.getByRole('button', { name: 'Artikel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Produkte', exact: true }).click(); const list = page.getByRole('dialog', { name: 'Produkte', exact: true }); await list.getByRole('textbox', { name: 'Produkte suchen', exact: true }).fill(name);
        await list.getByRole('gridcell', { name, exact: true }).first().dblclick(); const parent = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).first(); await parent.getByRole('tab', { name: 'Varianten', exact: true }).click();
        await parent.getByRole('gridcell', { name: `${name}.1`, exact: true }).dblclick(); const variant = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).last();
        await variant.getByRole('checkbox', { name: 'Vom Hauptprodukt übernehmen: Produktname', exact: true }).check(); await expect(variant.getByRole('textbox', { name: 'Produktname:', exact: true })).toHaveValue(name);
        await variant.getByRole('checkbox', { name: 'Vom Hauptprodukt übernehmen: Standardpreis', exact: true }).check(); await expect(variant.getByRole('spinbutton', { name: /Bruttopreis/ })).toHaveAttribute('aria-valuenow', '59.5');
        await variant.getByRole('checkbox', { name: 'Vom Hauptprodukt übernehmen: Beschreibung', exact: true }).uncheck();
        await variant.getByText('Weitere Produktdaten', { exact: true }).click();
        await variant.getByRole('checkbox', { name: 'Vom Hauptprodukt übernehmen: Versandkostenfrei', exact: true }).check();
        await variant.getByRole('checkbox', { name: 'Vom Hauptprodukt übernehmen: EAN / GTIN', exact: true }).uncheck(); await variant.getByRole('textbox', { name: 'EAN / GTIN:', exact: true }).fill('1234567890123');
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/product/${childId}`) && response.request().method() === 'PATCH'), variant.getByRole('button', { name: 'Speichern', exact: true }).click()]); expect(saved.ok()).toBeTruthy();
        const raw = (await (await request.post('/api/search/product', { headers, data: { ids: [childId], limit: 1 } })).json()).data[0];
        expect(raw.name).toBeNull(); expect(raw.price).toBeNull(); expect(raw.shippingFree).toBeNull(); expect(raw.description).toBe('Beschreibung des Hauptprodukts'); expect(raw.stock).toBe(4); expect(raw.ean).toBe('1234567890123');
        const effective = (await (await request.post('/api/search/product', { headers: { ...headers, 'sw-inheritance': '1' }, data: { ids: [childId], limit: 1 } })).json()).data[0]; expect(effective.price[0].gross).toBe(59.5); expect(effective.price[0].listPrice.gross).toBe(71.4); expect(errors).toEqual([]);
    } finally { expect((await request.delete(`/api/product/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Varianten zeigen geerbte Zuordnungen, übernehmen eigene Werte und stellen die Vererbung wieder her', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const id = uid(); const childId = uid(); const name = `EMZ-ASSOC-${Date.now()}`;
    const categoryId = uid(); const tagId = uid(); const groupId = uid(); const optionId = uid(); const setId = uid(); const created: [string, string][] = [];
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
    const relations = [['Kategorien', 'categories', categoryId], ['Tags', 'tags', tagId], ['Eigenschaften', 'properties', optionId], ['Zusatzfeld-Sets', 'customFieldSets', setId]];
    try {
        for (const [entity, data] of [['category', { id: categoryId, name, active: false }], ['tag', { id: tagId, name }],
            ['property-group', { id: groupId, name, displayType: 'text', sortingType: 'alphanumeric', options: [{ id: optionId, name }] }],
            ['custom-field-set', { id: setId, name: `emz_assoc_${Date.now()}`, global: false, active: true, relations: [{ entityName: 'product' }] }]] as [string, any][]) {
            expect((await request.post(`/api/${entity}`, { headers, data })).ok()).toBeTruthy(); created.push([entity, data.id]);
        }
        expect((await request.post('/api/product', { headers, data: { id, name, productNumber: name, stock: 0, active: false, taxId: tax.id, price: [{ currencyId: currency.id, gross: 11.9, net: 10, linked: true }],
            ...Object.fromEntries(relations.map(([, association, ref]) => [association, [{ id: ref }]])), children: [{ id: childId, productNumber: `${name}.1`, stock: 0 }] } })).ok()).toBeTruthy(); created.push(['product', id]);
        await login(page); await page.evaluate(() => { location.hash = 'products'; }); const list = page.getByRole('dialog', { name: 'Produkte', exact: true });
        await list.getByRole('textbox', { name: 'Produkte suchen', exact: true }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const parent = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).first(); await parent.getByRole('tab', { name: 'Varianten', exact: true }).click(); await parent.getByRole('row').filter({ hasText: `${name}.1` }).dblclick();
        const variant = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).last();
        await expect(variant.getByRole('textbox', { name: 'Artikelnummer:', exact: true })).toHaveValue(`${name}.1`);
        for (const [title, association, ref] of relations) {
            await variant.getByRole('tab', { name: title, exact: true }).click(); const tab = variant.getByRole('tabpanel', { name: title, exact: true }); await expect(tab.getByText('Vom Hauptprodukt geerbt', { exact: true })).toBeVisible();
            await tab.getByRole('button', { name: 'Zuordnungen übernehmen', exact: true }).click(); await expect(tab.getByText('Eigene Zuordnungen', { exact: true })).toBeVisible();
            const own = (await (await request.post('/api/search/product', { headers, data: { ids: [childId], limit: 1, associations: { [association]: { limit: 10 } } } })).json()).data[0]; expect(own[association].map(item => item.id)).toEqual([ref]);
            await tab.getByRole('button', { name: 'Vom Hauptprodukt erben', exact: true }).click(); await page.getByRole('alertdialog', { name: 'Zuordnungen vererben?', exact: true }).getByRole('button', { name: 'Ja', exact: true }).click();
            await expect(tab.getByText('Vom Hauptprodukt geerbt', { exact: true })).toBeVisible();
            const raw = (await (await request.post('/api/search/product', { headers, data: { ids: [id, childId], limit: 2, associations: { [association]: { limit: 10 } } } })).json()).data;
            expect(raw.find(product => product.id === childId)[association]).toHaveLength(0); expect(raw.find(product => product.id === id)[association].map(item => item.id)).toEqual([ref]);
        }
    } finally { for (const [entity, id] of created.reverse()) expect((await request.delete(`/api/${entity}/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Varianten übernehmen Bilder, Verkaufskanäle, Cross-Selling und Preisstaffeln ohne das Hauptprodukt zu verändern', async ({ page, request }) => {
    test.setTimeout(60000);
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const id = uid(); const childId = uid(); const name = `EMZ-CHILD-REL-${Date.now()}`;
    const mediaId = uid(); const imageId = uid(); const ruleId = uid(); const created: [string, string][] = [];
    const first = async entity => (await (await request.post(`/api/search/${entity}`, { headers, data: { limit: 1 } })).json()).data[0];
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0]; const tax = await first('tax'); const channel = await first('sales-channel');
    const price = [{ currencyId: currency.id, gross: 11.9, net: 10, linked: true }];
    try {
        for (const [entity, data] of [['media', { id: mediaId }], ['rule', { id: ruleId, name, priority: 1 }]] as [string, any][]) { expect((await request.post(`/api/${entity}`, { headers, data })).ok()).toBeTruthy(); created.push([entity, data.id]); }
        expect((await request.post('/api/product', { headers, data: { id, name, productNumber: name, stock: 0, active: false, taxId: tax.id, price, coverId: imageId,
            media: [{ id: imageId, mediaId, position: 1 }], visibilities: [{ salesChannelId: channel.id, visibility: 30 }],
            prices: [{ ruleId, quantityStart: 2, price }], crossSellings: [{ name, position: 1, active: false, type: 'productList', assignedProducts: [{ productId: childId, position: 1 }] }],
            children: [{ id: childId, productNumber: `${name}.1`, stock: 0 }] } })).ok()).toBeTruthy(); created.push(['product', id]);
        await login(page); await page.evaluate(() => { location.hash = 'products'; }); const list = page.getByRole('dialog', { name: 'Produkte', exact: true }); await list.getByRole('textbox', { name: 'Produkte suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const parent = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).first(); await parent.getByRole('tab', { name: 'Varianten', exact: true }).click(); await parent.getByRole('row').filter({ hasText: `${name}.1` }).dblclick();
        const variant = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).last(); await expect(variant.getByRole('textbox', { name: 'Artikelnummer:', exact: true })).toHaveValue(`${name}.1`);
        for (const [title, entity] of [['Bilder', 'product-media'], ['Verkaufskanäle', 'product-visibility'], ['Cross-Selling', 'product-cross-selling'], ['Erweiterte Preise', 'product-price']]) {
            await variant.getByRole('tab', { name: title, exact: true }).click(); const tab = variant.getByRole('tabpanel', { name: title, exact: true }); await expect(tab.getByText('Vom Hauptprodukt geerbt', { exact: true })).toBeVisible();
            await tab.getByRole('button', { name: 'Eigene Einträge verwenden', exact: true }).click(); await expect(tab.getByText('Eigene Einträge', { exact: true })).toBeVisible();
            const own = (await (await request.post(`/api/search/${entity}`, { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'productId', value: childId }], ...(entity === 'product-cross-selling' ? { associations: { assignedProducts: { limit: 10 } } } : {}) } })).json()).data;
            expect(own).toHaveLength(1); if (entity === 'product-cross-selling') expect(own[0].assignedProducts[0].productId).toBe(childId);
            if (entity === 'product-media') { const variantRecord = (await (await request.post('/api/search/product', { headers, data: { ids: [childId], limit: 1 } })).json()).data[0]; expect(variantRecord.coverId).toBe(own[0].id); expect(variantRecord.coverId).not.toBe(imageId); }
            await tab.getByRole('button', { name: 'Vom Hauptprodukt erben', exact: true }).click(); await page.getByRole('alertdialog', { name: 'Einträge vererben?', exact: true }).getByRole('button', { name: 'Ja', exact: true }).click(); await expect(tab.getByText('Vom Hauptprodukt geerbt', { exact: true })).toBeVisible();
            const remaining = await request.post(`/api/search/${entity}`, { headers, data: { limit: 10, filter: [{ type: 'equalsAny', field: 'productId', value: [id, childId] }] } }); const rows = (await remaining.json()).data; expect(rows).toHaveLength(1); expect(rows[0].productId).toBe(id);
        }
    } finally { for (const [entity, id] of created.reverse()) expect((await request.delete(`/api/${entity}/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Massenbearbeitung ersetzt und entfernt Tags für alle Suchtreffer und erhält andere Produktwerte', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const ids = [uid(), uid()]; const tags = [uid(), uid()]; const name = `EMZ-BULK-REL-${Date.now()}`;
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0]; const created: [string, string][] = [];
    try {
        for (const [index, id] of tags.entries()) { expect((await request.post('/api/tag', { headers, data: { id, name: `${name}-${index}` } })).ok()).toBeTruthy(); created.push(['tag', id]); }
        for (const [index, id] of ids.entries()) { expect((await request.post('/api/product', { headers, data: { id, name: `${name}-${index}`, productNumber: `${name}-${index}`, stock: 7 + index, active: false, taxId: tax.id,
            price: [{ currencyId: currency.id, gross: 11.9, net: 10, linked: true }], tags: [{ id: tags[0] }] } })).ok()).toBeTruthy(); created.push(['product', id]); }
        await login(page); await page.evaluate(() => { location.hash = 'products'; }); const list = page.getByRole('dialog', { name: 'Produkte', exact: true }); await list.getByRole('textbox', { name: 'Produkte suchen' }).fill(name); await expect(list.getByText(/· 2 Produkte/)).toBeVisible();
        for (const action of ['Ersetzen', 'Entfernen']) {
            await list.getByRole('button', { name: 'Alle Treffer bearbeiten', exact: true }).click(); const bulk = page.getByRole('dialog', { name: 'Produkte gemeinsam bearbeiten', exact: true });
            await bulk.getByRole('tab', { name: 'Zuordnungen', exact: true }).click();
            await bulk.getByRole('combobox', { name: 'Änderung: Tags:', exact: true }).click(); await page.getByRole('option', { name: action, exact: true }).click();
            const reference = bulk.getByRole('combobox', { name: 'Tags', exact: true }); await reference.locator('input').fill(`${name}-1`); await page.getByRole('option', { name: `${name}-1`, exact: true }).click();
            await bulk.getByRole('button', { name: 'Änderungen anwenden', exact: true }).click(); await page.getByRole('alertdialog', { name: 'Massenänderung anwenden?', exact: true }).getByRole('button', { name: 'Ja', exact: true }).click(); await expect(bulk).not.toBeVisible();
            const records = (await (await request.post('/api/search/product', { headers, data: { ids, limit: 2, associations: { tags: { limit: 10 } } } })).json()).data;
            for (const [index, id] of ids.entries()) { const record = records.find(product => product.id === id); expect(record.tags.map(tag => tag.id)).toEqual(action === 'Ersetzen' ? [tags[1]] : []); expect(record.stock).toBe(7 + index); expect(record.price[0].gross).toBe(11.9); }
        }
    } finally { for (const [entity, id] of created.reverse()) expect((await request.delete(`/api/${entity}/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Variantendarstellung und Ausschlüsse werden gespeichert und bei der Generierung beachtet', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', '');
    const productId = uid(); const groupIds = [uid(), uid()]; const optionIds = [uid(), uid(), uid(), uid()]; const name = `EMZ-CONFIGURATOR-${Date.now()}`;
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0]; const created: string[] = [];
    try {
        for (const [index, groupId] of groupIds.entries()) {
            expect((await request.post('/api/property-group', { headers, data: { id: groupId, name: `${name} ${index ? 'Größe' : 'Farbe'}`, displayType: 'text', sortingType: 'alphanumeric',
                options: optionIds.slice(index * 2, index * 2 + 2).map((id, option) => ({ id, name: index ? ['M', 'L'][option] : ['Rot', 'Blau'][option] })) } })).ok()).toBeTruthy(); created.push(groupId);
        }
        expect((await request.post('/api/product', { headers, data: { id: productId, name, productNumber: name, stock: 0, active: false, taxId: tax.id, price: [{ currencyId: currency.id, gross: 119, net: 100, linked: true }], configuratorSettings: optionIds.map(optionId => ({ optionId })) } })).ok()).toBeTruthy();
        await login(page); await page.getByRole('button', { name: 'Artikel', exact: true }).click(); await page.getByRole('menuitem', { name: 'Produkte', exact: true }).click(); const list = page.getByRole('dialog', { name: 'Produkte', exact: true }); await list.getByRole('textbox', { name: 'Produkte suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Variantendarstellung', exact: true }).click();
        const listingMode = editor.getByRole('combobox', { name: 'Darstellung in Produktlisten:', exact: true });
        await listingMode.click();
        await page.getByRole('option', { name: 'Varianten nach Gruppen auffächern', exact: true }).click();
        await editor.getByRole('row').filter({ hasText: `${name} Farbe` }).locator('.x-grid-checkcolumn').click();
        await editor.getByRole('button', { name: 'Ausschluss hinzufügen', exact: true }).click(); const exclusion = page.getByRole('dialog', { name: 'Variantenkombination ausschließen', exact: true });
        await exclusion.getByRole('combobox', { name: `${name} Farbe`, exact: true }).locator('input').fill('Rot'); await page.getByRole('option', { name: 'Rot', exact: true }).click();
        await exclusion.getByRole('combobox', { name: `${name} Größe`, exact: true }).locator('input').fill('M'); await page.getByRole('option', { name: 'M', exact: true }).click();
        await exclusion.getByRole('button', { name: 'Übernehmen', exact: true }).click(); const [saved] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith(`/api/product/${productId}`) && response.request().method() === 'PATCH'), editor.getByRole('button', { name: 'Varianteneinstellungen speichern', exact: true }).click(),
        ]); expect(saved.ok(), (await saved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        const product = (await (await request.post('/api/search/product', { headers, data: { ids: [productId], limit: 1 } })).json()).data[0];
        expect(product.variantListingConfig.displayParent).toBe(false); expect(product.variantListingConfig.configuratorGroupConfig.find(group => group.id === groupIds[0]).expressionForListings).toBe(true); expect(product.variantRestrictions[0].values).toHaveLength(2);
        await editor.getByRole('tab', { name: 'Varianten', exact: true }).click(); await editor.getByRole('button', { name: 'Varianten erzeugen', exact: true }).click(); const generator = page.getByRole('dialog', { name: 'Varianten erzeugen', exact: true });
        await expect(generator).toContainText('3 neue Kombinationen.'); await generator.getByRole('button', { name: 'Ausgewählte Varianten erzeugen' }).click(); await expect(generator).not.toBeVisible();
        const variants = (await (await request.post('/api/search/product', { headers, data: { limit: 10, filter: [{ type: 'equals', field: 'parentId', value: productId }], associations: { options: {} } } })).json()).data;
        expect(variants).toHaveLength(3); expect(variants.some(variant => variant.options.some(option => option.id === optionIds[0]) && variant.options.some(option => option.id === optionIds[2]))).toBeFalsy();
    } finally {
        await request.delete(`/api/product/${productId}`, { headers }); for (const id of created) expect((await request.delete(`/api/property-group/${id}`, { headers })).ok()).toBeTruthy();
    }
});

test('Kategorienbaum sortiert, verschiebt und verhindert zyklische Eltern; interne Links werden gespeichert', async ({ page, request }) => {
    test.setTimeout(60000);
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const rootId = uid(); const targetId = uid(); const ids = [uid(), uid(), uid()]; const name = `EMZ-TREE-${Date.now()}`; let linkId: string | undefined;
    expect((await request.post('/api/category', { headers, data: { id: rootId, name, active: false, children: ids.map((id, index) => ({ id, name: `${name}-${index}`, active: false, afterCategoryId: ids[index - 1] || null })) } })).ok()).toBeTruthy();
    expect((await request.post('/api/category', { headers, data: { id: targetId, name: `${name}-Ziel`, active: false } })).ok()).toBeTruthy();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const read = async id => (await (await request.post('/api/search/category', { headers, data: { ids: [id], limit: 1 } })).json()).data[0];
    try {
        await login(page); await page.evaluate(() => { location.hash = 'categories'; }); const list = page.getByRole('dialog', { name: 'Kategorien', exact: true }); await list.getByRole('tab', { name: 'Baum', exact: true }).click();
        const tree = list.getByRole('tabpanel', { name: 'Baum', exact: true });
        const expand = async () => { await tree.getByRole('row').filter({ has: page.getByText(name, { exact: true }) }).locator('.x-tree-expander').click(); };
        await expand(); await tree.getByText(`${name}-1`, { exact: true }).click(); await tree.getByRole('button', { name: 'Nach oben', exact: true }).click();
        await expect.poll(async () => (await read(ids[1])).afterCategoryId).toBeNull();
        await expand(); await tree.getByText(`${name}-1`, { exact: true }).click(); await tree.getByRole('button', { name: 'Verschieben', exact: true }).click();
        const move = page.getByRole('dialog', { name: 'Kategorie verschieben', exact: true }); await chooseReference(page, move, 'Zielkategorie (leer = Hauptebene):', `${name}-Ziel`); await move.getByRole('button', { name: 'Verschieben', exact: true }).click();
        await expect.poll(async () => (await read(ids[1])).parentId).toBe(targetId); expect((await read(ids[0])).afterCategoryId).toBeNull(); expect((await read(ids[2])).afterCategoryId).toBe(ids[0]);
        await list.getByRole('tab', { name: 'Liste', exact: true }).click(); await list.getByRole('textbox', { name: 'Kategorien suchen' }).fill(name); await list.getByRole('gridcell', { name, exact: true }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Kategorie bearbeiten', exact: true }); await chooseReference(page, editor, 'Übergeordnete Kategorie:', `${name}-0`); await editor.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(editor.getByRole('alert')).toContainText('Unterkategorien');
        await editor.getByRole('button', { name: 'Abbrechen', exact: true }).click(); await page.getByRole('alertdialog', { name: 'Änderungen verwerfen?', exact: true }).getByRole('button', { name: 'Ja', exact: true }).click();
        await list.getByRole('button', { name: 'Kategorie anlegen', exact: true }).click(); const create = page.getByRole('dialog', { name: 'Kategorie anlegen', exact: true });
        await create.getByRole('textbox', { name: 'Name:', exact: true }).fill(`${name}-Link`); await create.getByRole('checkbox', { name: 'Aktiv:', exact: true }).uncheck();
        await create.getByRole('combobox', { name: 'Typ:', exact: true }).click(); await page.getByRole('option', { name: 'Link', exact: true }).click();
        await create.getByRole('tab', { name: 'Verlinkung', exact: true }).click();
        await create.getByRole('combobox', { name: 'Linkziel:', exact: true }).click(); await page.getByRole('option', { name: 'Kategorie', exact: true }).click(); await chooseReference(page, create, 'Kategorie als Linkziel:', name);
        const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/category') && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]); expect(response.ok()).toBeTruthy(); linkId = response.request().postDataJSON().id;
        const stored = await read(linkId); expect(stored.type).toBe('link'); expect(stored.linkType).toBe('category'); expect(stored.internalLink).toBe(rootId); expect(errors).toEqual([]);
    } finally { if (linkId) await request.delete(`/api/category/${linkId}`, { headers }); expect((await request.delete(`/api/category/${rootId}`, { headers })).ok()).toBeTruthy(); expect((await request.delete(`/api/category/${targetId}`, { headers })).ok()).toBeTruthy(); }
});

for (const headless of [false, true]) test(`SEO-Vorlage und Haupt-URLs für ${headless ? 'Headless' : 'Storefront'} liefern Vorschau und erhalten Weiterleitungen`, async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const name = `EMZ-SEO-${Date.now()}`;
    await page.goto('/admin'); const typeId = headless ? await page.locator('#emz-admin-config').getAttribute('data-headless-type-id') : undefined;
    const channelId = await createTestSalesChannel(request, headers, name, typeId); const productId = randomUUID().replaceAll('-', ''); let templateId: string | undefined;
    const domain = `https://${name.toLowerCase()}.example.invalid`;
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0]; const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
    expect((await request.post('/api/product', { headers, data: { id: productId, name, productNumber: name, stock: 1, active: true, taxId: tax.id,
        price: [{ currencyId: currency.id, gross: 11.9, net: 10, linked: true }], visibilities: [{ salesChannelId: channelId, visibility: 30 }] } })).ok()).toBeTruthy();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        if (headless) {
            const snippet = (await (await request.post('/api/search/snippet-set', { headers, data: { limit: 1 } })).json()).data[0];
            const languageId = await page.locator('#emz-admin-config').getAttribute('data-language-id');
            expect((await request.post('/api/sales-channel-domain', { headers, data: { url: domain, salesChannelId: channelId, languageId, currencyId: currency.id, snippetSetId: snippet.id, isExternalStorefront: true } })).ok()).toBeTruthy();
        }
        await login(page); await page.evaluate(() => { location.hash = 'seo-templates'; }); const list = page.getByRole('dialog', { name: 'SEO-URL-Vorlagen', exact: true }); await list.getByRole('button', { name: 'Kanalvorlage anlegen', exact: true }).click();
        const template = page.getByRole('dialog', { name: 'SEO-Kanalvorlage anlegen', exact: true }); await template.getByRole('combobox', { name: 'Seitentyp:', exact: true }).click(); await page.getByRole('option', { name: headless ? 'Produkte · Headless' : 'Produkte · Storefront', exact: true }).click();
        await chooseReference(page, template, 'Verkaufskanal:', name); await template.getByRole('textbox', { name: 'URL-Vorlage (Twig):', exact: true }).fill('test-seo/{{ product.productNumber }}');
        await template.getByRole('button', { name: 'Vorschau prüfen', exact: true }).click(); await expect(template.getByRole('gridcell', { name: `${headless ? domain + '/' : ''}test-seo/${name}`, exact: true })).toBeVisible();
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/seo-url-template') && response.request().method() === 'POST'), template.getByRole('button', { name: 'Speichern', exact: true }).click()]); expect(saved.ok()).toBeTruthy(); templateId = saved.request().postDataJSON().id; await expect(template).not.toBeVisible();
        await page.evaluate(() => { location.hash = 'products'; }); const products = page.getByRole('dialog', { name: 'Produkte', exact: true }); await products.getByRole('textbox', { name: 'Produkte suchen' }).fill(name); await products.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'SEO-URLs', exact: true }).click();
        const urls = async () => (await (await request.post('/api/search/seo-url', { headers, data: { limit: 25, filter: [{ type: 'equals', field: 'foreignKey', value: productId }, { type: 'equals', field: 'salesChannelId', value: channelId }] } })).json()).data;
        for (const suffix of ['eins', 'zwei', 'reset']) {
            await editor.getByRole('button', { name: 'SEO-URL festlegen', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'SEO-URL festlegen', exact: true }); await chooseReference(page, dialog, 'Verkaufskanal:', name);
            if (suffix !== 'reset') await dialog.getByRole('textbox', { name: 'SEO-Pfad:', exact: true }).fill(`${name}-${suffix}`);
            const [changed] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/seo-url/canonical')), dialog.getByRole('button', { name: suffix === 'reset' ? 'Vorlagen-URL wiederherstellen' : 'Haupt-URL speichern', exact: true }).click()]);
            expect(changed.ok(), (await changed.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); await expect(dialog).not.toBeVisible();
            const rows = await urls(); const canonical = rows.filter(row => row.isCanonical); expect(canonical).toHaveLength(1); expect(canonical[0].seoPathInfo).toBe(suffix === 'reset' ? `test-seo/${name}` : `${name}-${suffix}`); expect(canonical[0].isDeleted).toBeFalsy();
            if (suffix !== 'eins') { const previous = rows.find(row => row.seoPathInfo === `${name}-eins`); expect(previous).toBeTruthy(); expect(previous.isCanonical).toBeFalsy(); expect(previous.isDeleted).toBeFalsy(); }
            if (suffix === 'reset') expect(canonical[0].isModified).toBeFalsy();
        }
        expect(errors).toEqual([]);
    } finally {
        const urls = (await (await request.post('/api/search/seo-url', { headers, data: { limit: 100, filter: [{ type: 'equals', field: 'foreignKey', value: productId }] } })).json()).data;
        for (const url of urls) expect((await request.delete(`/api/seo-url/${url.id}`, { headers })).ok()).toBeTruthy();
        if (templateId) expect((await request.delete(`/api/seo-url-template/${templateId}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/product/${productId}`, { headers })).ok()).toBeTruthy(); expect((await request.delete(`/api/sales-channel/${channelId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Produktfeed wird mit Twig-Vorlagen geprüft, gespeichert und als echte Vorschau heruntergeladen', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const name = `EMZ-FEED-${Date.now()}`;
    const channelId = uid(); const productId = uid(); const streamId = uid(); let feedId: string | undefined; const created: [string, string][] = [];
    try {
        await login(page); const typeId = await page.locator('#emz-admin-config').getAttribute('data-product-export-type-id'); expect(typeId).toBeTruthy();
        const domain = (await (await request.post('/api/search/sales-channel-domain', { headers, data: { limit: 1, associations: { salesChannel: {} } } })).json()).data[0]; expect(domain).toBeTruthy();
        const source = domain.salesChannel; const fields = ['languageId', 'currencyId', 'customerGroupId', 'countryId', 'paymentMethodId', 'shippingMethodId', 'navigationCategoryId'];
        const accessKey = (await (await request.get('/api/_action/access-key/sales-channel', { headers })).json()).accessKey;
        expect((await request.post('/api/sales-channel', { headers, data: { ...Object.fromEntries(fields.map(key => [key, source[key]])), id: channelId, typeId, name, accessKey, active: false,
            countries: [{ id: source.countryId }], currencies: [{ id: source.currencyId }], languages: [{ id: source.languageId }] } })).ok()).toBeTruthy(); created.push(['sales-channel', channelId]);
        const currencyId = await page.locator('#emz-admin-config').getAttribute('data-currency-id'); const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
        expect((await request.post('/api/product', { headers, data: { id: productId, name, productNumber: name, active: true, stock: 1, taxId: tax.id,
            price: [{ currencyId, gross: 119, net: 100, linked: true }], visibilities: [{ salesChannelId: source.id, visibility: 30 }] } })).ok()).toBeTruthy(); created.push(['product', productId]);
        expect((await request.post('/api/product-stream', { headers, data: { id: streamId, name, filters: [{ type: 'equals', field: 'productNumber', value: name }] } })).ok()).toBeTruthy(); created.push(['product-stream', streamId]);
        await page.evaluate(() => { location.hash = 'product-exports'; }); const list = page.getByRole('dialog', { name: 'Produktfeeds', exact: true }); await list.getByRole('button', { name: 'Produktfeed anlegen', exact: true }).click();
        const create = page.getByRole('dialog', { name: 'Produktfeed anlegen', exact: true }); await chooseReference(page, create, 'Export-Verkaufskanal:', name); await chooseReference(page, create, 'Storefront-Domain:', domain.url); await chooseReference(page, create, 'Dynamische Produktgruppe:', name);
        await create.getByRole('textbox', { name: 'Dateiname:', exact: true }).fill(`${name}.csv`);
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/product-export') && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]); expect(saved.ok()).toBeTruthy(); feedId = saved.request().postDataJSON().id; created.push(['product-export', feedId!]);
        await expect(create).not.toBeVisible(); await list.getByRole('textbox', { name: 'Produktfeeds suchen', exact: true }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick(); const editor = page.getByRole('dialog', { name: 'Produktfeed bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Vorlagen & Vorschau', exact: true }).click();
        await editor.getByRole('textbox', { name: 'Kopfzeile (Twig):', exact: true }).fill('Artikelnummer;Name\n'); await editor.getByRole('textbox', { name: 'Produktzeile (Twig):', exact: true }).fill('{{ product.productNumber }};{{ product.translated.name }}\n');
        const [validated] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/product-export/validate')), editor.getByRole('button', { name: 'Vorlagen speichern', exact: true }).click()]); expect(validated.ok()).toBeTruthy();
        await expect.poll(async () => (await (await request.post('/api/search/product-export', { headers, data: { ids: [feedId], limit: 1 } })).json()).data[0].bodyTemplate).toBe('{{ product.productNumber }};{{ product.translated.name }}\n');
        await editor.getByRole('button', { name: 'Vorschau erzeugen', exact: true }).click(); await expect(editor.getByRole('textbox', { name: 'Vorschau:', exact: true })).toHaveValue(new RegExp(name));
        const [download] = await Promise.all([page.waitForEvent('download'), editor.getByRole('button', { name: 'Vorschau herunterladen', exact: true }).click()]); expect(await readFile((await download.path())!, 'utf8')).toContain(name);
        await editor.getByRole('textbox', { name: 'Produktzeile (Twig):', exact: true }).fill('{% invalid_template_tag %}'); await editor.getByRole('button', { name: 'Vorlagen prüfen', exact: true }).click(); await expect(editor.getByRole('alert')).not.toBeEmpty();
        const unchanged = (await (await request.post('/api/search/product-export', { headers, data: { ids: [feedId], limit: 1 } })).json()).data[0]; expect(unchanged.bodyTemplate).not.toContain('invalid_template_tag');
    } finally { for (const [entity, id] of created.reverse()) expect((await request.delete(`/api/${entity}/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Verkaufskanal-Maßsystem speichert passende Einheiten ohne die globale Konfiguration zu ändern', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const name = `EMZ-MEASURE-${Date.now()}`; const id = await createTestSalesChannel(request, headers, name);
    const before = await (await request.get('/api/_action/system-config?domain=core.measurementUnits', { headers })).json();
    const systems = (await (await request.post('/api/search/measurement-system', { headers, data: { limit: 100, associations: { units: { limit: 100 } } } })).json()).data;
    const system = systems.find(system => system.technicalName === 'imperial'); expect(system).toBeTruthy();
    try {
        await login(page); await page.evaluate(() => { location.hash = 'sales-channels'; }); const list = page.getByRole('dialog', { name: 'Verkaufskanäle', exact: true }); await list.getByRole('textbox', { name: 'Verkaufskanäle suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Verkaufskanal bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Maßsystem', exact: true }).click(); await editor.getByRole('combobox', { name: 'Maßsystem:', exact: true }).click(); await page.getByRole('option', { name: system.translated?.name || system.name, exact: true }).click();
        const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/sales-channel/${id}`) && response.request().method() === 'PATCH'), editor.getByRole('button', { name: 'Maßsystem speichern', exact: true }).click()]); expect(saved.ok()).toBeTruthy();
        const channel = (await (await request.post('/api/search/sales-channel', { headers, data: { ids: [id], limit: 1 } })).json()).data[0]; expect(channel.measurementUnits.system).toBe('imperial');
        for (const type of ['length', 'weight']) expect(Object.values(system.units).some((unit: any) => unit.type === type && unit.shortName === channel.measurementUnits.units[type])).toBeTruthy();
        expect(await (await request.get('/api/_action/system-config?domain=core.measurementUnits', { headers })).json()).toEqual(before);
    } finally { expect((await request.delete(`/api/sales-channel/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Erstattungsauftrag wird über einen lokalen Test-Zahlungshandler genau einmal ausgeführt', async ({ page, request }) => {
    test.setTimeout(120000);
    const headers = await integrationHeaders(request); const name = 'EmzExtAdminRefundFixture'; const namespace = 'Emz\\ExtAdminRefundFixture';
    const directory = await mkdtemp(join(tmpdir(), 'emz-refund-')); const plugin = join(directory, name); const archive = join(directory, 'fixture.zip');
    const uid = () => randomUUID().replaceAll('-', ''); const paymentId = uid(); const refundId = uid(); let order; let uploaded = false; let paymentCreated = false;
    const manifest = { name: 'emz/ext-admin-refund-fixture', description: 'Local refund test without external payment calls', version: '1.0.0', type: 'shopware-platform-plugin', license: 'MIT',
        autoload: { 'psr-4': { [namespace + '\\']: 'src/' } }, require: { 'shopware/core': '~6.7.0' }, extra: { 'shopware-plugin-class': namespace + '\\' + name, label: { 'de-DE': name } } };
    const fixture = new URL('../../../custom/plugins/EmzExtAdministration/tests/fixtures/refund/', import.meta.url);
    const existing = (await (await request.post('/api/search/plugin', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } })).json()).data;
    expect(existing).toHaveLength(0);
    await mkdir(join(plugin, 'src/Resources/config'), { recursive: true }); await writeFile(join(plugin, 'composer.json'), JSON.stringify(manifest));
    for (const file of ['Handler.php', 'EmzExtAdminRefundFixture.php']) await writeFile(join(plugin, 'src', file), await readFile(new URL(file, fixture)));
    await writeFile(join(plugin, 'src/Resources/config/services.xml'), await readFile(new URL('services.xml', fixture)));
    execFileSync('zip', ['-qr', archive, name], { cwd: directory, stdio: 'ignore' });
    try {
        const upload = await request.post('/api/_action/extension/upload', { headers, multipart: { file: { name: 'fixture.zip', mimeType: 'application/zip', buffer: await readFile(archive) } } }); uploaded = true; expect(upload.ok()).toBeTruthy();
        expect((await request.post('/api/_action/extension/install/plugin/' + name, { headers, data: {} })).ok()).toBeTruthy();
        expect((await request.put('/api/_action/extension/activate/plugin/' + name, { headers, data: {} })).ok()).toBeTruthy();
        const payment = await request.post('/api/payment-method', { headers, data: { id: paymentId, name, technicalName: 'emz_refund_probe', active: false, handlerIdentifier: namespace + '\\Handler' } });
        expect(payment.ok(), (await payment.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); paymentCreated = true;
        order = await createTestOrder(request, headers);
        const transaction = (await (await request.post('/api/search/order-transaction', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'orderId', value: order.id }] } })).json()).data[0];
        expect((await request.patch('/api/order-transaction/' + transaction.id, { headers, data: { paymentMethodId: paymentId } })).ok()).toBeTruthy();
        const amount = { unitPrice: 19, totalPrice: 19, quantity: 1, calculatedTaxes: [], taxRules: [] };
        const initialState = async (machine, technicalName) => (await (await request.post('/api/search/state-machine-state', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'stateMachine.technicalName', value: machine }, { type: 'equals', field: 'technicalName', value: technicalName }] } })).json()).data[0].id;
        const captureState = await initialState('order_transaction_capture.state', 'completed'); const refundState = await initialState('order_transaction_capture_refund.state', 'open');
        const capture = await request.post('/api/order-transaction-capture', { headers, data: { id: uid(), orderTransactionId: transaction.id, stateId: captureState, amount,
            refunds: [{ id: refundId, stateId: refundState, reason: name, amount, positions: [{ orderLineItemId: order.lineItems[0].id, quantity: 1, amount }] }] } });
        expect(capture.ok(), (await capture.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'orders'; }); const list = page.getByRole('dialog', { name: 'Bestellungen', exact: true });
        await list.getByRole('textbox', { name: 'Bestellungen suchen', exact: true }).fill(order.orderNumber); await list.getByRole('row').filter({ hasText: order.orderNumber }).dblclick();
        const detail = page.getByRole('dialog', { name: 'Bestellung ' + order.orderNumber, exact: true }); await detail.getByRole('tab', { name: 'Erstattungen', exact: true }).click();
        await detail.getByRole('row').filter({ hasText: name }).click(); await detail.getByRole('button', { name: 'Erstattung ausführen', exact: true }).click();
        const [processed] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/order_transaction_capture_refund/' + refundId)), page.getByRole('alertdialog').getByRole('button', { name: 'Ja', exact: true }).click()]);
        expect(processed.ok(), (await processed.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        const stored = (await (await request.post('/api/search/order-transaction-capture-refund', { headers, data: { ids: [refundId], limit: 1, associations: { stateMachineState: {} } } })).json()).data[0];
        expect(stored.stateMachineState.technicalName).toBe('completed');
        const replay = await request.post('/api/_action/order_transaction_capture_refund/' + refundId, { headers, data: {} }); expect(replay.ok()).toBeFalsy();
        await detail.getByRole('row').filter({ hasText: name }).dblclick(); const refund = page.getByRole('dialog', { name: 'Erstattung bearbeiten', exact: true });
        await refund.getByRole('tab', { name: 'Erstattete Positionen', exact: true }).click(); await expect(refund.getByRole('row').filter({ hasText: 'Ext-Admin-Testposition' })).toBeVisible();
    } finally {
        if (order) expect((await request.delete('/api/order/' + order.id, { headers })).ok()).toBeTruthy();
        if (paymentCreated) expect((await request.delete('/api/payment-method/' + paymentId, { headers })).ok()).toBeTruthy();
        if (uploaded) {
            const registered = (await (await request.post('/api/search/plugin', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } })).json()).data?.[0];
            if (registered?.active) await request.put('/api/_action/extension/deactivate/plugin/' + name, { headers });
            if (registered?.installedAt) await request.post('/api/_action/extension/uninstall/plugin/' + name, { headers, data: { keepUserData: false } });
            if (registered) await request.post('/api/_action/extension/remove/plugin/' + name, { headers, data: { keepUserData: false } });
            await rm(new URL('../../../custom/plugins/' + name, import.meta.url), { recursive: true, force: true });
        }
        await rm(directory, { recursive: true, force: true });
    }
});

test('Erweiterungsverwaltung lädt ein eigenes Testplugin hoch, installiert, aktiviert und entfernt es vollständig', async ({ page, request }) => {
    test.setTimeout(120000);
    const headers = await integrationHeaders(request); const name = `EmzExtAdminProbe${Date.now()}`; const directory = await mkdtemp(join(tmpdir(), 'emz-extension-'));
    const plugin = join(directory, name); const archive = join(directory, `${name}.zip`); let uploaded = false;
    const manifest = { name: `emz/ext-admin-probe-${Date.now()}`, description: 'Temporary local administration acceptance fixture', version: '1.0.0', type: 'shopware-platform-plugin', license: 'MIT',
        autoload: { 'psr-4': { [`Emz\\${name}\\`]: 'src/' } }, require: { 'shopware/core': '~6.7.0' }, extra: { 'shopware-plugin-class': `Emz\\${name}\\${name}`, label: { 'de-DE': name, 'en-GB': name } } };
    await mkdir(join(plugin, 'src/Resources/config'), { recursive: true });
    await writeFile(join(plugin, 'composer.json'), JSON.stringify(manifest, null, 4));
    await writeFile(join(plugin, `src/${name}.php`), `<?php declare(strict_types=1);\nnamespace Emz\\${name};\nuse Shopware\\Core\\Framework\\Plugin;\nfinal class ${name} extends Plugin {}\n`);
    await writeFile(join(plugin, 'src/Resources/config/config.xml'), '<?xml version="1.0" encoding="UTF-8"?><config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://raw.githubusercontent.com/shopware/shopware/trunk/src/Core/System/SystemConfig/Schema/config.xsd"><card><title>Test</title><input-field type="bool"><name>enabled</name><label>Test aktiviert</label><defaultValue>false</defaultValue></input-field></card></config>');
    execFileSync('zip', ['-qr', archive, name], { cwd: directory, stdio: 'ignore' });
    try {
        await login(page); await page.evaluate(() => { location.hash = 'extensions'; }); const list = page.getByRole('dialog', { name: 'Erweiterungen', exact: true });
        await list.getByRole('button', { name: 'ZIP hochladen', exact: true }).click(); const upload = page.getByRole('dialog', { name: 'Erweiterung hochladen', exact: true }); await upload.locator('input[type=file]').setInputFiles(archive);
        const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/extension/upload')), upload.getByRole('button', { name: 'Hochladen', exact: true }).click()]); uploaded = true;
        expect(response.ok(), (await response.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy();
        const select = async () => { await list.getByRole('textbox', { name: 'Erweiterungen suchen', exact: true }).fill(name); await list.getByRole('row').filter({ hasText: name }).click(); };
        const action = async (label, path, method) => {
            await select(); await list.getByRole('button', { name: label, exact: true }).click(); const confirm = page.getByRole('dialog', { name: `Erweiterung: ${label}`, exact: true });
            const [result] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/_action/extension/${path}/plugin/${name}`) && response.request().method() === method), confirm.getByRole('button', { name: label, exact: true }).click()]);
            expect(result.ok(), (await result.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); await expect(confirm).not.toBeVisible();
        };
        await action('Installieren', 'install', 'POST'); await action('Aktivieren', 'activate', 'PUT');
        await select(); await expect(list.getByRole('button', { name: 'Deaktivieren', exact: true })).toBeEnabled(); await list.getByRole('button', { name: 'Konfiguration', exact: true }).click();
        const config = page.getByRole('dialog', { name: `Konfiguration: ${name}`, exact: true }); await config.getByRole('checkbox', { name: 'Test aktiviert:', exact: true }).check();
        const [configured] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/system-config/batch')), config.getByRole('button', { name: 'Speichern', exact: true }).click()]); expect(configured.ok()).toBeTruthy();
        const values = await (await request.get(`/api/_action/system-config?domain=${name}.config`, { headers })).json(); expect(values[`${name}.config.enabled`]).toBe(true);
        await page.keyboard.press('Escape'); await expect(config).not.toBeVisible();
        manifest.version = '1.0.1'; await writeFile(join(plugin, 'composer.json'), JSON.stringify(manifest, null, 4)); execFileSync('zip', ['-qr', archive, name], { cwd: directory, stdio: 'ignore' });
        await list.getByRole('button', { name: 'ZIP hochladen', exact: true }).click(); await upload.locator('input[type=file]').setInputFiles(archive);
        const [updatedUpload] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/_action/extension/upload')), upload.getByRole('button', { name: 'Hochladen', exact: true }).click()]); expect(updatedUpload.ok()).toBeTruthy();
        await expect(upload).not.toBeVisible(); await action('Aktualisieren', 'update', 'POST');
        const updatedPlugin = (await (await request.post('/api/search/plugin', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } })).json()).data[0]; expect(updatedPlugin.version).toBe('1.0.1');
        await action('Deaktivieren', 'deactivate', 'PUT'); await action('Deinstallieren', 'uninstall', 'POST'); await action('Dateien entfernen', 'remove', 'POST');
        expect((await (await request.post('/api/search/plugin', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } })).json()).data).toHaveLength(0);
    } finally {
        if (uploaded) {
            const result = await request.post('/api/search/plugin', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'name', value: name }] } }); const registered = (await result.json()).data?.[0];
            if (registered?.active) await request.put(`/api/_action/extension/deactivate/plugin/${name}`, { headers });
            if (registered?.installedAt) await request.post(`/api/_action/extension/uninstall/plugin/${name}`, { headers, data: { keepUserData: false } });
            if (registered) await request.post(`/api/_action/extension/remove/plugin/${name}`, { headers, data: { keepUserData: false } });
            await request.post('/api/_action/system-config/batch', { headers, data: { null: { [`${name}.config.enabled`]: null } } });
            const path = new URL(`../../../custom/plugins/${name}`, import.meta.url); await rm(path, { recursive: true, force: true });
        }
        await rm(directory, { recursive: true, force: true });
    }
});

test('Aktive Agentur-Plugins verwalten Team, Anleitungen, Schritte, Produkte und Tag-SEO', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const name = `EMZ-AGENCY-${Date.now()}`; const created: [string, string][] = [];
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(new URL(response.url()).pathname + ': ' + response.status()); });
    const first = async entity => (await (await request.post(`/api/search/${entity}`, { headers, data: { limit: 1 } })).json()).data[0];
    try {
        await login(page);
        for (const [route, title, singular, entity, field] of [['team', 'Teamverwaltung', 'Teammitglied', 'emz-team-member', 'Name:'], ['instructions', 'Bastelanleitungen', 'Bastelanleitung', 'emz-instruction', 'Überschrift:'], ['tags', 'Tags', 'Tag', 'tag', 'Name:']]) {
            await page.evaluate(route => { location.hash = route; }, route); const list = page.getByRole('dialog', { name: title, exact: true });
            await list.getByRole('button', { name: `${singular} anlegen`, exact: true }).click(); const create = page.getByRole('dialog', { name: `${singular} anlegen`, exact: true });
            await create.getByRole('textbox', { name: field, exact: true }).fill(name);
            if (entity === 'tag') await create.getByRole('textbox', { name: 'Tag-Meta-Titel:', exact: true }).fill('SEO für Bastelideen');
            const [saved] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/${entity}`) && response.request().method() === 'POST'), create.getByRole('button', { name: 'Speichern', exact: true }).click()]);
            expect(saved.ok(), (await saved.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); created.push([entity, saved.request().postDataJSON().id]); await expect(create).not.toBeVisible();
        }
        const teamId = created[0][1]; const instructionId = created[1][1]; const tagId = created[2][1];
        const tag = (await (await request.post('/api/search/tag', { headers, data: { ids: [tagId], limit: 1, associations: { tagExtension: {} } } })).json()).data[0]; expect(tag.extensions.tagExtension.metaTitle).toBe('SEO für Bastelideen');
        await page.evaluate(() => { location.hash = 'team'; }); const teamList = page.getByRole('dialog', { name: 'Teamverwaltung', exact: true });
        await teamList.getByRole('textbox', { name: 'Teamverwaltung suchen' }).fill(name); await teamList.getByRole('row').filter({ hasText: name }).dblclick();
        const member = page.getByRole('dialog', { name: 'Teammitglied bearbeiten', exact: true }); await member.getByRole('textbox', { name: 'Position / Beruf:', exact: true }).fill('Entwicklung');
        await member.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(member).not.toBeVisible();
        expect((await (await request.post('/api/search/emz-team-member', { headers, data: { ids: [teamId], limit: 1 } })).json()).data[0].position).toBe('Entwicklung');
        await page.evaluate(() => { location.hash = 'instructions'; }); const list = page.getByRole('dialog', { name: 'Bastelanleitungen', exact: true });
        await list.getByRole('textbox', { name: 'Bastelanleitungen suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const instruction = page.getByRole('dialog', { name: 'Bastelanleitung bearbeiten', exact: true }); await instruction.getByRole('tab', { name: 'Tags', exact: true }).click();
        await instruction.getByRole('button', { name: 'Zuordnen', exact: true }).click(); const assignTag = page.getByRole('dialog', { name: 'Tags zuordnen', exact: true });
        await chooseReference(page, assignTag, 'Tags:', name); await assignTag.getByRole('button', { name: 'Zuordnen', exact: true }).click(); await expect(assignTag).not.toBeVisible();
        await expect(instruction.getByRole('row').filter({ hasText: name })).toBeVisible();
        await instruction.getByRole('tab', { name: 'Schritte', exact: true }).click(); await instruction.getByRole('button', { name: 'Schritt anlegen', exact: true }).click();
        const step = page.getByRole('dialog', { name: 'Schritt anlegen', exact: true }); await step.getByRole('textbox', { name: 'Alternativer Schritttitel:', exact: true }).fill('Material vorbereiten');
        await step.getByRole('textbox', { name: 'Beschreibung (HTML):', exact: true }).fill('<p>Alle Teile auflegen.</p>');
        const [savedStep] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/emz-instruction-step') && response.request().method() === 'POST'), step.getByRole('button', { name: 'Speichern', exact: true }).click()]);
        expect(savedStep.ok(), (await savedStep.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); const stepId = savedStep.request().postDataJSON().id; await expect(step).not.toBeVisible();
        await instruction.getByRole('row').filter({ hasText: 'Material vorbereiten' }).dblclick(); const editStep = page.getByRole('dialog', { name: 'Schritt bearbeiten', exact: true });
        const product = (await (await request.post('/api/search/product', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'parentId', value: null }] } })).json()).data[0];
        await editStep.getByRole('tab', { name: 'Produkte', exact: true }).click(); await editStep.getByRole('button', { name: 'Zuordnen', exact: true }).click();
        const assign = page.getByRole('dialog', { name: 'Produkte zuordnen', exact: true }); await chooseReference(page, assign, 'Produkte:', product.translated?.name || product.name, product.productNumber);
        await assign.getByRole('button', { name: 'Zuordnen', exact: true }).click(); await expect(assign).not.toBeVisible(); await expect(editStep.getByRole('row').filter({ hasText: product.productNumber })).toBeVisible();
        const record = (await (await request.post('/api/search/emz-instruction', { headers, data: { ids: [instructionId], limit: 1, associations: { tags: {}, instructionSteps: { associations: { products: {} } } } } })).json()).data[0];
        expect(record.showOptions).toBe('inactive'); expect(record.active).toBe(false); expect(record.tags.map(item => item.id)).toEqual([tagId]); expect(record.instructionSteps[0].id).toBe(stepId); expect(record.instructionSteps[0].products[0].id).toBe(product.id); expect(errors).toEqual([]);
        await editStep.getByRole('button', { name: 'Abbrechen', exact: true }).click(); await instruction.getByRole('button', { name: 'Abbrechen', exact: true }).click();
        await list.getByRole('row').filter({ hasText: name }).click(); await list.getByRole('button', { name: 'Löschen', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Ja', exact: true }).click(); await expect(list.getByRole('row').filter({ hasText: name })).toHaveCount(0);
        created.splice(created.findIndex(([entity]) => entity === 'emz-instruction'), 1);
        expect((await (await request.post('/api/search/emz-instruction-step', { headers, data: { ids: [stepId], limit: 1 } })).json()).data).toHaveLength(0);
        expect((await (await request.post('/api/search/product', { headers, data: { ids: [product.id], limit: 1 } })).json()).data).toHaveLength(1);
    } finally {
        const instructionId = created.find(([entity]) => entity === 'emz-instruction')?.[1]; const tagId = created.find(([entity]) => entity === 'tag')?.[1];
        if (instructionId && tagId) await request.delete(`/api/emz-instruction/${instructionId}/tags/${tagId}`, { headers });
        for (const [entity, id] of created.reverse()) {
            const deleted = await request.delete(`/api/${entity}/${id}`, { headers });
            expect.soft(deleted.ok(), `${entity}: ${(await deleted.json().catch(() => ({}))).errors?.[0]?.detail}`).toBeTruthy();
        }
    }
});

test('Agentur-CMS-Elemente wählen echte Teammitglieder und Anleitungen und zeigen sie in der Vorschau', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const name = `EMZ-PLUGIN-CMS-${Date.now()}`; const ids = [uid(), uid(), uid()]; const slots = [uid(), uid()]; const created: [string, string][] = [];
    try {
        for (const [entity, data] of [['emz-team-member', { id: ids[0], name, information: '<p>Unser Team</p>' }], ['emz-instruction', { id: ids[1], headline: name, active: false, showOptions: 'inactive', releaseDate: new Date().toISOString() }],
            ['cms-page', { id: ids[2], name, type: 'page', sections: [{ type: 'default', position: 0, blocks: [
                { type: 'emz_team_management_block', position: 0, sectionPosition: 'main', slots: [{ id: slots[0], type: 'emz_team_management_element', slot: 'center', config: { teamMembers: { source: 'static', value: [] } } }] },
                { type: 'emzTinkerInstructionWidgetRowThree', position: 1, sectionPosition: 'main', slots: [{ id: slots[1], type: 'emzTinkerInstructionWidget', slot: 'center', config: { tinkerInstruction: { source: 'static', value: [] } } }] },
            ] }] }]] as [string, any][]) {
            const response = await request.post(`/api/${entity}`, { headers, data }); expect(response.ok(), (await response.json().catch(() => ({}))).errors?.[0]?.detail).toBeTruthy(); created.push([entity, data.id]);
        }
        await login(page); await page.evaluate(() => { location.hash = 'cms'; }); const list = page.getByRole('dialog', { name: 'Erlebniswelten', exact: true });
        await list.getByRole('textbox', { name: 'Erlebniswelten suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Erlebniswelt bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Gestaltung', exact: true }).click();
        for (const [index, title, label, key] of [[0, 'Team', 'Teammitglieder', 'teamMembers'], [1, 'Bastelanleitungen', 'Bastelanleitungen', 'tinkerInstruction']] as [number, string, string, string][]) {
            await editor.getByRole('row').filter({ hasText: `center: ${title}` }).dblclick(); const element = page.getByRole('dialog', { name: 'Element bearbeiten', exact: true });
            await element.getByRole('combobox', { name: label, exact: true }).locator('input').fill(name); await page.getByRole('option', { name, exact: true }).click();
            await element.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(element).not.toBeVisible();
            const slot = (await (await request.post('/api/search/cms-slot', { headers, data: { ids: [slots[index]], limit: 1 } })).json()).data[0]; expect(slot.config[key].value).toEqual([ids[index]]);
        }
        const preview = editor.frameLocator('iframe[title="Layout-Vorschau"]'); await expect(preview.getByRole('heading', { name, exact: true })).toHaveCount(2); await expect(preview.getByText('Unser Team', { exact: true })).toBeVisible();
    } finally { for (const [entity, id] of created.reverse()) expect((await request.delete(`/api/${entity}/${id}`, { headers })).ok()).toBeTruthy(); }
});

test('Wechsel zur nativen Shopware-Administration und zurück erhält die Anmeldung', async ({ page }) => {
    test.setTimeout(90000);
    await login(page); await page.getByRole('button', { name: 'Shopware-Administration öffnen', exact: true }).click();
    await expect(page).toHaveURL(/native=1/); await expect(page.locator('.sw-dashboard')).toBeVisible({ timeout: 60000 });
    await page.goto('/admin'); await expect(page.getByRole('heading', { name: 'Dein Shop im Überblick' })).toBeVisible();
    expect(await page.evaluate(() => document.cookie.includes('bearerAuth='))).toBe(false);
});

test('CMS-Variantenüberschreibung bewahrt geerbte Nachbarinhalte und stellt die Vererbung wieder her', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const pageId = uid(); const productId = uid(); const childId = uid(); const slots = [uid(), uid()]; const name = `EMZ-CMS-INHERIT-${Date.now()}`;
    const currency = (await (await request.post('/api/search/currency', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'factor', value: 1 }] } })).json()).data[0];
    const tax = (await (await request.post('/api/search/tax', { headers, data: { limit: 1 } })).json()).data[0];
    const configs = Object.fromEntries(slots.map((id, index) => [id, { content: { source: 'static', value: `Elterninhalt ${index}` } }]));
    const read = async (id, inherited = false) => (await (await request.post('/api/search/product', { headers: { ...headers, 'sw-inheritance': inherited ? '1' : '0' }, data: { ids: [id], limit: 1 } })).json()).data[0];
    try {
        expect((await request.post('/api/cms-page', { headers, data: { id: pageId, name, type: 'product_detail', sections: [{ type: 'default', position: 0, blocks: slots.map((id, position) => ({ type: 'text', name: `Text ${position}`, position, sectionPosition: 'main', slots: [{ id, type: 'text', slot: 'content', config: { content: { source: 'static', value: 'Layout' } } }] })) }] } })).ok()).toBeTruthy();
        expect((await request.post('/api/product', { headers, data: { id: productId, name, productNumber: name, taxId: tax.id, stock: 0, active: false, cmsPageId: pageId, slotConfig: configs,
            price: [{ currencyId: currency.id, net: 10, gross: 11.9, linked: true }], children: [{ id: childId, productNumber: `${name}.1`, stock: 0 }] } })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'products'; }); const list = page.getByRole('dialog', { name: 'Produkte', exact: true }); await list.getByRole('textbox', { name: 'Produkte suchen' }).fill(name); await list.getByRole('row').filter({ hasText: name }).dblclick();
        const parent = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).first(); await parent.getByRole('tab', { name: 'Varianten', exact: true }).click(); await parent.getByRole('row').filter({ hasText: `${name}.1` }).dblclick();
        const activeEditor = page.getByRole('dialog', { name: 'Produkt bearbeiten', exact: true }).last(); await expect(activeEditor.getByRole('textbox', { name: 'Artikelnummer:', exact: true })).toHaveValue(`${name}.1`);
        const child = page.locator('#' + await activeEditor.getAttribute('id')); await child.getByRole('tab', { name: 'Layout-Inhalte', exact: true }).click(); await child.getByRole('row').filter({ hasText: 'Text 0' }).dblclick();
        const element = page.getByRole('dialog', { name: 'Inhalt überschreiben', exact: true }); await expect(element.getByRole('textbox', { name: 'Text (HTML):', exact: true })).toHaveValue('Elterninhalt 0');
        await element.getByRole('textbox', { name: 'Text (HTML):', exact: true }).fill('Varianteninhalt'); await element.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(element).not.toBeVisible();
        const raw = await read(childId); expect(raw.slotConfig[slots[0]].content.value).toBe('Varianteninhalt'); expect(raw.slotConfig[slots[1]]).toEqual(configs[slots[1]]); expect((await read(productId)).slotConfig).toEqual(configs);
        await child.getByRole('row').filter({ hasText: 'Text 0' }).click(); await child.getByRole('button', { name: 'Layout-Vorgabe verwenden', exact: true }).click();
        await page.getByRole('alertdialog', { name: 'Individuellen Inhalt zurücksetzen?', exact: true }).getByRole('button', { name: 'Ja', exact: true }).click();
        await expect.poll(async () => (await read(childId)).slotConfig).toBeNull(); expect((await read(childId, true)).translated.slotConfig).toEqual(configs);
    } finally { await request.delete(`/api/product/${productId}`, { headers }); expect((await request.delete(`/api/cms-page/${pageId}`, { headers })).ok()).toBeTruthy(); }
});

test('Bestellentwurf übernimmt eine Kundenadresse und wechselt die Zahlungsart erst beim Übernehmen', async ({ page, request }) => {
    test.setTimeout(90000);
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', ''); const customerId = uid(); const addressId = uid(); const paymentId = uid();
    const order = await createTestOrder(request, headers); let versionId: string | undefined; let customerCreated = false; let paymentCreated = false;
    const name = `EMZ-ORDER-META-${Date.now()}`;
    const read = async () => (await (await request.post('/api/search/order', { headers, data: { ids: [order.id], limit: 1, associations: { orderCustomer: {}, addresses: {}, transactions: {} } } })).json()).data[0];
    try {
        const channel = (await (await request.post('/api/search/sales-channel', { headers, data: { ids: [order.salesChannelId], limit: 1 } })).json()).data[0];
        const salutation = (await (await request.post('/api/search/salutation', { headers, data: { limit: 1 } })).json()).data[0];
        const payment = (await (await request.post('/api/search/payment-method', { headers, data: { ids: [order.transactions[0].paymentMethodId], limit: 1 } })).json()).data[0];
        expect((await request.post('/api/payment-method', { headers, data: { id: paymentId, technicalName: name.toLowerCase(), name, active: false, handlerIdentifier: payment.handlerIdentifier } })).ok()).toBeTruthy(); paymentCreated = true;
        expect((await request.post('/api/customer', { headers, data: { id: customerId, customerNumber: name, email: `${name.toLowerCase()}@example.invalid`, password: randomUUID(), active: false,
            firstName: 'Ext', lastName: 'Adresskunde', salutationId: salutation.id, groupId: channel.customerGroupId, salesChannelId: channel.id, defaultBillingAddressId: addressId, defaultShippingAddressId: addressId,
            addresses: [{ id: addressId, firstName: 'Ext', lastName: 'Adresskunde', salutationId: salutation.id, street: 'Neue Teststraße 8', zipcode: '23456', city: 'Neustadt', countryId: channel.countryId }] } })).ok()).toBeTruthy(); customerCreated = true;
        const before = await read(); expect((await request.patch(`/api/order-customer/${before.orderCustomer.id}`, { headers, data: { customerId } })).ok()).toBeTruthy();
        await login(page); await page.evaluate(() => { location.hash = 'orders'; }); const list = page.getByRole('dialog', { name: 'Bestellungen', exact: true }); await list.getByRole('textbox', { name: 'Bestellungen suchen' }).fill(order.orderNumber); await list.getByRole('row').filter({ hasText: order.orderNumber }).dblclick();
        const detail = page.getByRole('dialog', { name: `Bestellung ${order.orderNumber}`, exact: true }); const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/_action/version/order/${order.id}`)), detail.getByRole('button', { name: 'Bestellung bearbeiten', exact: true }).click()]); versionId = (await created.json()).versionId;
        const draft = page.getByRole('dialog', { name: 'Bestellung bearbeiten', exact: true }); await draft.getByRole('tab', { name: 'Adressen', exact: true }).click(); await draft.getByRole('row').filter({ hasText: 'Teststraße 1' }).click();
        await draft.getByRole('button', { name: 'Aus Kundenadresse übernehmen', exact: true }).click(); const copy = page.getByRole('dialog', { name: 'Kundenadresse übernehmen', exact: true });
        await chooseReference(page, copy, 'Kundenadresse:', 'Neue Teststraße 8 · 23456 · Neustadt', 'Neue Teststraße'); await copy.getByRole('button', { name: 'Übernehmen', exact: true }).click(); await expect(copy).not.toBeVisible(); await expect(draft.getByRole('row').filter({ hasText: 'Neue Teststraße 8' })).toBeVisible();
        await draft.getByRole('tab', { name: 'Zahlungsdaten', exact: true }).click(); await draft.getByRole('tabpanel', { name: 'Zahlungsdaten', exact: true }).locator('.x-grid-item').first().dblclick(); const editPayment = page.getByRole('dialog', { name: 'Zahlungsdaten bearbeiten', exact: true });
        await chooseReference(page, editPayment, 'Zahlungsart:', name); await editPayment.getByRole('button', { name: 'Speichern', exact: true }).click(); await expect(editPayment).not.toBeVisible();
        const unchanged = await read(); expect(unchanged.addresses[0].street).toBe('Teststraße 1'); expect(unchanged.transactions[0].paymentMethodId).toBe(payment.id);
        await draft.getByRole('button', { name: 'Neu berechnen', exact: true }).click(); await expect(draft.getByText(/Gesamt:/)).toBeVisible(); await draft.getByRole('button', { name: 'Änderungen übernehmen', exact: true }).click(); await expect(draft).not.toBeVisible(); versionId = undefined;
        const saved = await read(); expect(saved.addresses[0].street).toBe('Neue Teststraße 8'); expect(saved.transactions[0].paymentMethodId).toBe(paymentId);
    } finally {
        if (versionId) await request.post(`/api/_action/version/${versionId}/order/${order.id}`, { headers, data: {} });
        expect((await request.delete(`/api/order/${order.id}`, { headers })).ok()).toBeTruthy();
        if (customerCreated) expect((await request.delete(`/api/customer/${customerId}`, { headers })).ok()).toBeTruthy();
        if (paymentCreated) expect((await request.delete(`/api/payment-method/${paymentId}`, { headers })).ok()).toBeTruthy();
    }
});

test('Übersetzte Kategorie-Links übernehmen den Sprach-Fallback und speichern eigene interne und externe Ziele', async ({ page, request }) => {
    const headers = await integrationHeaders(request); const uid = () => randomUUID().replaceAll('-', '');
    const categoryId = uid(); const firstId = uid(); const secondId = uid(); const languageId = uid(); const name = `EMZ-LINK-LANG-${Date.now()}`;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page);
    const parentId = await page.locator('#emz-admin-config').getAttribute('data-language-id');
    const locale = (await (await request.post('/api/search/locale', { headers, data: { limit: 1, filter: [{ type: 'equals', field: 'code', value: 'en-GB' }] } })).json()).data[0];
    const read = async (translated = false) => (await (await request.post('/api/search/category', { headers: { ...headers, ...(translated ? { 'sw-language-id': languageId } : {}) }, data: { ids: [categoryId], limit: 1 } })).json()).data[0];
    try {
        expect((await request.post('/api/language', { headers, data: { id: languageId, name, parentId, localeId: locale.id, translationCodeId: locale.id } })).ok()).toBeTruthy();
        for (const [id, suffix] of [[firstId, 'Erstes Ziel'], [secondId, 'Zweites Ziel']]) expect((await request.post('/api/category', { headers, data: { id, name: `${name} ${suffix}`, active: false } })).ok()).toBeTruthy();
        expect((await request.post('/api/category', { headers, data: { id: categoryId, name, active: false, type: 'link', linkType: 'category', internalLink: firstId, linkNewTab: true } })).ok()).toBeTruthy();
        await page.evaluate(() => { location.hash = 'categories'; }); const list = page.getByRole('dialog', { name: 'Kategorien', exact: true });
        await list.getByRole('tab', { name: 'Liste', exact: true }).click(); await list.getByRole('textbox', { name: 'Kategorien suchen' }).fill(name); await list.getByRole('gridcell', { name, exact: true }).dblclick();
        const editor = page.getByRole('dialog', { name: 'Kategorie bearbeiten', exact: true }); await editor.getByRole('tab', { name: 'Übersetzungen', exact: true }).click();
        const translation = editor.getByRole('tabpanel', { name: 'Übersetzungen', exact: true }); await chooseReference(page, translation, 'Sprache:', name);
        await translation.getByRole('button', { name: 'Übersetzung laden', exact: true }).click(); await expect(translation.getByRole('textbox', { name: 'Name:', exact: true })).toHaveValue('');
        await expect(translation.getByRole('combobox', { name: 'Linkziel:', exact: true })).toHaveValue('Kategorie');
        await expect(translation.getByRole('combobox', { name: 'Kategorie als Linkziel:', exact: true })).toHaveValue(`${name} Erstes Ziel`);
        await expect(translation.getByRole('checkbox', { name: 'In neuem Tab öffnen:', exact: true })).toBeChecked();
        const save = async () => {
            const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith(`/api/category/${categoryId}`) && response.request().method() === 'PATCH'), translation.getByRole('button', { name: 'Übersetzung speichern', exact: true }).click()]);
            expect(response.ok()).toBeTruthy(); expect(response.request().headers()['sw-language-id']).toBe(languageId);
        };
        await translation.getByRole('textbox', { name: 'Name:', exact: true }).fill(`${name} Translated`); await save();
        expect((await read(true)).internalLink).toBeNull(); expect((await read(true)).translated.internalLink).toBe(firstId);
        await chooseReference(page, translation, 'Kategorie als Linkziel:', `${name} Zweites Ziel`); await save();
        expect((await read(true)).internalLink).toBe(secondId); expect((await read()).internalLink).toBe(firstId);
        await translation.getByRole('combobox', { name: 'Linkziel:', exact: true }).click(); await page.getByRole('option', { name: 'Externe URL', exact: true }).click();
        await translation.getByRole('textbox', { name: 'Externer Link:', exact: true }).fill('https://translated.example.invalid/path'); await translation.getByRole('checkbox', { name: 'In neuem Tab öffnen:', exact: true }).uncheck(); await save();
        const translated = await read(true); expect(translated.linkType).toBe('external'); expect(translated.externalLink).toBe('https://translated.example.invalid/path'); expect(translated.internalLink).toBeNull(); expect(translated.linkNewTab).toBe(false);
        const original = await read(); expect(original.name).toBe(name); expect(original.linkType).toBe('category'); expect(original.internalLink).toBe(firstId); expect(original.linkNewTab).toBe(true);
        await translation.getByRole('button', { name: 'Übersetzung laden', exact: true }).click(); await expect(translation.getByRole('combobox', { name: 'Linkziel:', exact: true })).toHaveValue('Externe URL'); expect(errors).toEqual([]);
    } finally {
        for (const id of [categoryId, firstId, secondId]) expect((await request.delete(`/api/category/${id}`, { headers })).ok()).toBeTruthy();
        expect((await request.delete(`/api/language/${languageId}`, { headers })).ok()).toBeTruthy();
    }
});
