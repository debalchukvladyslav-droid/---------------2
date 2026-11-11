// Keep screen-specific code out of the startup import graph. Concurrent actions
// share a load; a failed request can be retried by the next action.
export function lazyActions(load, names) {
    let pending = null;
    const getModule = () => {
        if (!pending) pending = Promise.resolve().then(load).catch((error) => {
            pending = null;
            throw error;
        });
        return pending;
    };
    return Object.fromEntries(names.map((name) => [name, async (...args) => {
        const module = await getModule();
        return module[name](...args);
    }]));
}
