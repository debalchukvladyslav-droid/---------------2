export default function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
    const epochMs = Date.now();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(200).json({ epochMs, iso: new Date(epochMs).toISOString() });
}
