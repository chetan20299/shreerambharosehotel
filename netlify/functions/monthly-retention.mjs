// Netlify Scheduled Function: nightly monthly roll-up (same job as the Firebase `monthlyRetention` function).
// 21:00 UTC = 02:30 IST.
import { runMonthlyRollup } from '../../functions/lib/retention.js';

export default async () => {
  const result = await runMonthlyRollup();
  console.log('monthly retention', JSON.stringify(result));
  return new Response('ok');
};

export const config = { schedule: '0 21 * * *' };
