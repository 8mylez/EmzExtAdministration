export const encode = value => Ext.String.htmlEncode(String(value ?? ''));

export function showError(error) {
    Ext.Msg.alert('Aktion nicht möglich', encode(error.message).replaceAll('\n', '<br>'));
}

export function money(value, currency) {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value || 0);
}

export function textColumn(text, dataIndex, config = {}) {
    return { text, dataIndex, renderer: encode, ...config };
}

export function notify(message) {
    Ext.toast({ html: encode(message), cls: 'emz-admin__toast', ariaRole: 'status', align: 'br', stickWhileHover: false, stickOnClick: false, enableAnimations: false, autoCloseDelay: 3500 });
}
