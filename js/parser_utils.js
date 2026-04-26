export function ecnFeeColumnIndex(headers) {
    const keys = ['Ecn Fee', 'ECN Fee', 'ECN', 'Ecn'];
    for (const key of keys) {
        if (headers?.[key] !== undefined) return headers[key];
    }
    return undefined;
}
