// === js/firebase.js ===
// firebaseConfig завантажується з config.js (підключений у index.html перед цим скриптом)

if (!firebase.apps.length) { 
    firebase.initializeApp(firebaseConfig); 
}

// MUST be called before any other Firestore operation.
// forceLongPolling disables WebChannel (the streaming transport that causes
// 404 / transport errored on networks with strict firewalls/proxies).
// useFetchStreams:false disables the experimental Fetch-based stream that
// also triggers the Listen RPC and the same 404 error.
// disableNetwork is NOT called — we want server reads, just via plain HTTP.
firebase.firestore().settings({
    experimentalForceLongPolling: true,
    experimentalAutoDetectLongPolling: false,
    merge: true,
});

export const db = firebase.firestore();
export const auth = firebase.auth();
export const storage = firebase.storage();

// Auth persistence: LOCAL keeps the token across page reloads so
// onAuthStateChanged fires once with the restored user.
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e =>
    console.error('Auth persistence error:', e)
);