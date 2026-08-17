import { runGrandmasterDailyReviews } from '../lib/grandmaster_review.js';

const tradeDate = process.argv[2];
if (tradeDate && !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error('Date must be YYYY-MM-DD');
const result = await runGrandmasterDailyReviews({ tradeDate });
console.log(JSON.stringify(result));
if (result.failed) process.exitCode = 1;
