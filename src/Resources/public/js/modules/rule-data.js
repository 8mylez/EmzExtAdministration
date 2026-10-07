export const conditionLabels = {
    andContainer: 'Alle Bedingungen (UND)', orContainer: 'Mindestens eine Bedingung (ODER)',
    alwaysValid: 'Immer gültig', salesChannel: 'Verkaufskanal', dayOfWeek: 'Wochentag', language: 'Sprache', currency: 'Währung',
    orderTag: 'Bestellungs-Tags', orderTrackingCode: 'Sendungsnummer vorhanden', orderDeliveryStatus: 'Lieferstatus',
    orderCreatedByAdmin: 'Bestellung durch Administration', orderTransactionStatus: 'Zahlungsstatus', orderStatus: 'Bestellstatus',
    orderDocumentType: 'Dokumenttyp', orderDocumentTypeSent: 'Versendeter Dokumenttyp', cartCartAmount: 'Warenkorbwert',
    cartPositionPrice: 'Positionswert', cartLineItemOfType: 'Positionstyp', promotionLineItem: 'Aktionsposition',
    promotionCodeOfType: 'Aktionscode-Typ', promotionValue: 'Aktionswert', promotionsInCartCount: 'Anzahl Aktionen im Warenkorb',
    cartLineItemTotalPrice: 'Gesamtpreis einer Position', cartLineItemUnitPrice: 'Einzelpreis einer Position',
    cartLineItemPerItemQuantity: 'Menge einer Position', cartShippingCost: 'Versandkosten', cartWeight: 'Warenkorbgewicht',
    cartVolume: 'Warenkorbvolumen', cartHasDeliveryFreeItem: 'Versandkostenfreie Position vorhanden',
    customerBillingCountry: 'Rechnungsland', customerBillingStreet: 'Rechnungsstraße', customerCustomerGroup: 'Kundengruppe',
    customerRequestedGroup: 'Angefragte Kundengruppe', customerTag: 'Kunden-Tags', customerCustomerNumber: 'Kundennummer',
    customerDifferentAddresses: 'Abweichende Lieferadresse', customerEmail: 'Kunden-E-Mail', customerIsActive: 'Kunde aktiv',
    customerLastName: 'Kunden-Nachname', customerIsCompany: 'Firmenkunde', cartTaxDisplay: 'Steuerdarstellung',
    cartTotalPurchasePrice: 'Gesamter Einkaufspreis', customerIsGuest: 'Gastkunde', customerIsNewsletterRecipient: 'Newsletterempfänger',
    customerShippingCountry: 'Lieferland', customerShippingStreet: 'Lieferstraße', customerBillingCity: 'Rechnungsort',
    customerShippingCity: 'Lieferort', customerBillingState: 'Bundesland der Rechnungsadresse', customerShippingState: 'Bundesland der Lieferadresse',
    customerLoggedIn: 'Kunde angemeldet', cartLineItemsInCartCount: 'Anzahl Warenkorbpositionen', numberOfReviews: 'Anzahl Bewertungen',
    customerOrderCount: 'Anzahl Kundenbestellungen', customerDaysSinceLastOrder: 'Tage seit letzter Bestellung',
    cartLineItemTag: 'Produkt-Tags', cartLineItemProperty: 'Produkteigenschaften', cartLineItemIsNew: 'Produkt neu',
    cartLineItemOfManufacturer: 'Hersteller', cartLineItemPurchasePrice: 'Einkaufspreis einer Position',
    cartLineItemCreationDate: 'Produkt erstellt am', cartLineItemReleaseDate: 'Produkt-Erscheinungsdatum',
    cartLineItemClearanceSale: 'Produkt im Abverkauf', cartLineItemPromoted: 'Produkt hervorgehoben',
    cartLineItemInCategory: 'Produkt in Kategorie', cartLineItemInProductStream: 'Produkt in dynamischer Produktgruppe',
    cartLineItemTaxation: 'Produkt-Steuersatz', cartLineItemDimensionWidth: 'Produktbreite', cartLineItemDimensionHeight: 'Produkthöhe',
    cartLineItemDimensionLength: 'Produktlänge', cartLineItemDimensionWeight: 'Produktgewicht', cartLineItemDimensionVolume: 'Produktvolumen',
    cartLineItemListPrice: 'Streichpreis', cartLineItemListPriceRatio: 'Streichpreis-Verhältnis', cartLineItemStock: 'Lagerbestand',
    cartLineItemActualStock: 'Tatsächlicher Lagerbestand', paymentMethod: 'Zahlungsart', shippingMethod: 'Versandart',
    customerOrderTotalAmount: 'Gesamter Bestellwert des Kunden', customerBirthday: 'Kunden-Geburtstag',
    customerCreatedByAdmin: 'Kunde durch Administration angelegt', cartLineItemProductStates: 'Produktstatus',
    cartLineItemProductType: 'Produkttyp', customerAge: 'Kundenalter', customerSalutation: 'Kunden-Anrede',
    customerDaysSinceLastLogin: 'Tage seit letzter Anmeldung', customerDaysSinceFirstLogin: 'Tage seit erster Anmeldung',
    customerAffiliateCode: 'Kunden-Partnercode', orderAffiliateCode: 'Bestellungs-Partnercode', orderCampaignCode: 'Bestellungs-Kampagnencode',
    customerCampaignCode: 'Kunden-Kampagnencode', cartLineItemPropertyValue: 'Eigenschaftswert',
    cartLineItemVariantValue: 'Variantenwert', adminSalesChannelSource: 'Bestellung über Administration',
};

const operatorLabels = { '=': 'Ist gleich', '!=': 'Ist ungleich', '>': 'Größer als', '>=': 'Größer oder gleich',
    '<': 'Kleiner als', '<=': 'Kleiner oder gleich', empty: 'Ist leer', '!empty': 'Ist nicht leer' };

export function conditionFields(schema) {
    const fields = [];
    if (schema.operatorSet?.operators?.length) fields.push({ name: 'operator', label: 'Vergleich', type: 'select', required: true,
        options: schema.operatorSet.operators.map(value => [value, operatorLabels[value] || value]) });
    for (const [name, field] of Object.entries(schema.fields || {})) {
        const descriptor = { name, label: Object.keys(schema.fields).length === 1 ? 'Wert' : name, required: true };
        if (field.type === 'multi-entity-id-select') fields.push({ ...descriptor, type: 'reference', multiple: true,
            reference: { entity: field.config.entity, filter: field.config.criteria?.filters,
                ...(field.config.entity === 'state_machine_state' ? { labelFields: ['name', 'technicalName'] } : {}) } });
        else if (field.type === 'single-select') fields.push({ ...descriptor, type: 'select', options: field.config.options.map(value => [value, String(value)]) });
        else fields.push({ ...descriptor, type: ({ float: 'number', int: 'integer', bool: 'boolean', tagged: 'lines', date: 'date', datetime: 'datetime' })[field.type] || 'text', dateOnly: field.type === 'date' });
    }
    return fields;
}

export function conditionChanges(original, current) {
    const previous = new Map(original.map(condition => [condition.id, condition]));
    const ids = new Set(current.map(condition => condition.id));
    const fields = ['id', 'parentId', 'type', 'position', 'value'];
    const normalized = condition => Object.fromEntries(fields.map(field => [field, condition[field] ?? (field === 'value' ? {} : null)]));
    return {
        upsert: current.filter(condition => !previous.has(condition.id)
            || JSON.stringify(normalized(condition)) !== JSON.stringify(normalized(previous.get(condition.id)))).map(normalized),
        delete: original.filter(condition => !ids.has(condition.id)).map(({ id }) => ({ id })),
    };
}
