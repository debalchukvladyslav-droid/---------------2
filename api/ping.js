export default function handler(req, res) {
    const key = process.env.GEMINI_API_KEY;
    const allKeys = Object.keys(process.env).filter(k => !k.includes('SECRET') && !k.includes('TOKEN'));
    res.status(200).json({
        configured: !!key,
        prefix: key ? key.slice(0, 6) + '...' : null,
        envCount: allKeys.length,
        envSample: allKeys.slice(0, 10),
    });
}
