// Supabase holds an internal auth lock while onAuthStateChange callbacks run.
// Any Supabase request started inside that callback can deadlock the client.
export function createDeferredAuthHandler(handler, {
    schedule = (callback) => setTimeout(callback, 0),
    onError = error => console.error('[AUTH] deferred handler failed:', error),
} = {}) {
    return (event, session) => {
        schedule(() => {
            try {
                Promise.resolve(handler(event, session)).catch(onError);
            } catch (error) {
                onError(error);
            }
        });
    };
}
