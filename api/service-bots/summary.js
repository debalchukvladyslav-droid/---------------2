import { handleServiceBotEndpoint } from '../_service_bots_lib.js';

export default function handler(req, res) {
    return handleServiceBotEndpoint(req, res, 'summary');
}
