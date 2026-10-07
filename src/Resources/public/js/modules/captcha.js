import { entityField } from '../entity-fields.js';
import { encode } from '../ui.js';

export async function captchaField(api, description, initial, writable) {
    const names = await api.request('/_action/captcha_list');
    const labels = { honeypot: 'Honeypot', basicCaptcha: 'Bild-Captcha', googleReCaptchaV2: 'Google reCAPTCHA v2', googleReCaptchaV3: 'Google reCAPTCHA v3' };
    const original = initial && !Array.isArray(initial) ? structuredClone(initial) : {};
    const fields = [];
    const panel = Ext.create('Ext.form.FieldContainer', { fieldLabel: encode(description.label), labelAlign: 'top', anchor: '100%', layout: 'anchor', items: [] });
    for (const name of names) {
        const descriptors = [{ name: `${name}.isActive`, label: `${labels[name] || name} aktiv`, type: 'boolean' }];
        if (['googleReCaptchaV2', 'googleReCaptchaV3'].includes(name)) descriptors.push(
            { name: `${name}.config.siteKey`, label: 'Website-Schlüssel' }, { name: `${name}.config.secretKey`, label: 'Geheimer Schlüssel', type: 'password' },
            name === 'googleReCaptchaV2' ? { name: `${name}.config.invisible`, label: 'Unsichtbares reCAPTCHA', type: 'boolean' }
                : { name: `${name}.config.thresholdScore`, label: 'Grenzwert (0 bis 1)', type: 'number', min: 0, max: 1, default: 0.5 });
        const items = descriptors.map(descriptor => {
            const value = descriptor.name.split('.').reduce((data, key) => data?.[key], original);
            const definition = entityField(api, { ...descriptor, name: `${description.name}.${descriptor.name}` }, value, writable);
            const field = Ext.widget(definition); fields.push({ descriptor, field }); return field;
        });
        panel.add({ xtype: 'fieldset', title: encode(labels[name] || name), items });
    }
    panel.getValue = () => {
        const value = structuredClone(original);
        for (const { descriptor, field } of fields) {
            const [name, key, nested] = descriptor.name.split('.'); value[name] ||= {};
            if (nested) { value[name][key] ||= {}; value[name][key][nested] = field.getValue(); }
            else value[name][key] = field.getValue();
        }
        return value;
    };
    panel.isDirty = () => fields.some(({ field }) => field.isDirty());
    panel.setReadOnly = readOnly => fields.forEach(({ field }) => field.setReadOnly(readOnly));
    return panel;
}
