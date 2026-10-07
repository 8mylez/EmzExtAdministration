export function buildFlowTree(sequences, label) {
    const byParent = new Map();
    const seen = new Set();
    for (const step of sequences) {
        const key = step.parentId || ''; if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(step);
    }
    for (const children of byParent.values()) children.sort((a, b) => a.position - b.position);
    function build(step, path = new Set()) {
        if (path.has(step.id)) throw new Error('Der Flow enthält eine zyklische Verknüpfung.');
        seen.add(step.id); const next = new Set(path); next.add(step.id);
        const children = byParent.get(step.id) || [];
        const node = { id: step.id, stepId: step.id, text: label(step), expanded: true, leaf: !children.length, action: Boolean(step.actionName) };
        if (!step.actionName) {
            node.leaf = false;
            node.children = [true, false].map(value => ({ id: `${step.id}-${value}`, text: value ? 'Erfüllt' : 'Nicht erfüllt', parentStepId: step.id, trueCase: value,
                expanded: true, children: children.filter(child => child.trueCase === value).map(child => build(child, next)) }));
        } else node.children = children.map(child => build(child, next));
        return node;
    }
    const roots = (byParent.get('') || []).map(step => build(step));
    if (seen.size !== sequences.length) throw new Error('Der Flow enthält nicht erreichbare oder zyklische Schritte. Bitte die Verknüpfungen in der Ablaufliste prüfen.');
    return roots;
}
