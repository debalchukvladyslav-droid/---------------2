export default function handler(req, res) {
    const key = process.env.GEMINI_API_KEY;
    res.status(200).json({
        configured: !!key,
        prefix: key ? key.slice(0, 6) + '...' : null,
    });
}
