export const entityPath = entity => entity.replaceAll('_', '-');
export const uuid = () => crypto.randomUUID().replaceAll('-', '');

export function valueAt(record, path) {
    return path.split('.').reduce((value, key) => value?.[key], record);
}

export function recordLabel(record, reference = {}) {
    if (reference.label) return reference.label(record);
    const fields = reference.labelFields || ['name'];
    return fields.map(field => valueAt(record, field) ?? record.translated?.[field]).filter(Boolean).join(' · ')
        || record.fileName || record.email || record.code || record.id;
}

export function listCriteria(definition, state) {
    const filters = [...(definition.filter || [])];
    if (state.term.trim() && definition.search?.length) {
        filters.push({ type: 'multi', operator: 'OR', queries: definition.search.map(field => ({
            type: 'contains', field, value: state.term.trim(),
        })) });
    }
    if (state.active !== undefined && state.active !== 'all') {
        filters.push({ type: 'equals', field: 'active', value: state.active === 'active' });
    }
    return {
        page: state.page, limit: 25, 'total-count-mode': 1, filter: filters,
        sort: [{ field: state.sort || definition.sort || 'createdAt', order: state.direction || 'DESC' }],
        ...(definition.associations ? { associations: definition.associations } : {}),
    };
}

export function fieldValue(field, value) {
    if (field.type === 'json') {
        if (value === '' || value === null || value === undefined) return null;
        try { return typeof value === 'string' ? JSON.parse(value) : value; }
        catch { throw new Error(`${field.label}: Bitte gültiges JSON eingeben.`); }
    }
    if (field.type === 'lines') return Array.isArray(value) ? value : String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
    if (field.multiple || field.type === 'multiselect') return Array.isArray(value) ? value : [];
    if (field.type === 'boolean') return Boolean(value);
    if (field.type === 'number' || field.type === 'integer') {
        if (value === '' || value === null || value === undefined) return null;
        const number = Number(value);
        if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) {
            throw new Error(`${field.label}: Bitte eine gültige Zahl eingeben.`);
        }
        return number;
    }
    if (field.type === 'datetime') {
        if (!value) return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error(`${field.label}: Bitte einen gültigen Zeitpunkt eingeben.`);
        return date.toISOString();
    }
    if (field.type === 'date') {
        if (!(value instanceof Date)) return value || null;
        if (field.dateOnly) return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
        return value.toISOString();
    }
    if (field.type === 'reference') return value || null;
    if (field.type === 'select') return value === '' ? null : value;
    return typeof value === 'string' && !['textarea', 'password'].includes(field.type) ? value.trim() : value ?? '';
}

export function entityPayload(definition, values, original, dirtyFields) {
    const payload = {};
    for (const field of definition.fields || []) {
        if (field.readOnly || (original && field.createOnly) || (!original && field.editOnly)) continue;
        if (original && !dirtyFields.has(field.name)) continue;
        const value = fieldValue(field, values[field.name]);
        if (field.type === 'password' && !value) continue;
        if (field.required && (value === null || value === '' || value === undefined)) {
            throw new Error(`${field.label} darf nicht leer sein.`);
        }
        const [root, ...path] = field.name.split('.');
        if (!path.length) { payload[root] = value; continue; }
        const source = original?.[root];
        payload[root] ??= source && typeof source === 'object' && !Array.isArray(source) ? structuredClone(source) : {};
        let target = payload[root];
        path.forEach((key, index) => {
            if (index === path.length - 1) target[key] = value;
            else target = target[key] ??= {};
        });
    }
    return payload;
}
