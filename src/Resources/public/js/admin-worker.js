export function startAdminWorker(api) {
    let stopped = false;
    const timers = new Set();
    const generation = api.generation;
    const active = () => !stopped && api.user && generation === api.generation;
    const exclusive = (key, action) => navigator.locks
        ? navigator.locks.request(`emz-admin:${api.baseUrl}:${key}`, { ifAvailable: true }, lock => lock && active() ? action() : null)
        : action();
    const schedule = (action, delay) => {
        if (!active()) return;
        const timer = setTimeout(() => { timers.delete(timer); if (active()) action(); }, delay);
        timers.add(timer);
    };
    async function consume(receiver) {
        if (!active()) return;
        let delay = 20000;
        try {
            const response = await exclusive(receiver, () => api.request('/_action/emz-ext-admin/message-queue/consume', 'POST', { receiver }));
            if (response?.handledMessages) delay = 1000;
        } catch (error) { if ([401, 403].includes(error.status)) return; }
        schedule(() => consume(receiver), delay);
    }
    async function tasks(interval) {
        if (!active()) return;
        try { await exclusive('scheduled-tasks', () => api.request('/_action/scheduled-task/run', 'POST', {})); }
        catch (error) { if ([401, 403].includes(error.status)) return; }
        schedule(() => tasks(interval), interval);
    }
    async function initialize() {
        if (!api.can('system:queue:process')) return;
        try {
            const config = await api.request('/_info/config');
            if (!active() || !config.adminWorker?.enableAdminWorker) return;
            for (const receiver of config.adminWorker.transports || []) consume(receiver);
            if (api.can('scheduled_task:read')) {
                const response = await api.request('/_action/scheduled-task/min-run-interval');
                if (response.minRunInterval > 0) schedule(() => tasks(response.minRunInterval * 1000), response.minRunInterval * 1000);
            }
        } catch { /* The backend worker remains independent of the administration session. */ }
    }
    initialize();
    const stop = () => { stopped = true; timers.forEach(clearTimeout); timers.clear(); window.removeEventListener('pagehide', stop); };
    window.addEventListener('pagehide', stop);
    return stop;
}
