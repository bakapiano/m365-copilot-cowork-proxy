import { verifyModel, startTurn, sseEvents, safeShape } from './upstream.mjs';
import { createAuthProvider } from './auth.mjs';

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60000);
try {
  const credentials = await createAuthProvider().getCredentials();
  console.log(JSON.stringify({ stage: 'model_check', model: await verifyModel(credentials) }));
  const turn = await startTurn(credentials,
    'API 格式验证：请只在聊天中回复 POC_TEXT_OK。请仅生成文本，保持工具和文件操作为空。',
    { signal: controller.signal });
  console.log(JSON.stringify({ stage: 'submitted', status: turn.httpStatus, accepted: turn.acceptedStatus }));
  let count = 0;
  for await (const event of sseEvents(turn.subscription)) {
    if (event.event !== 'tk' && count++ < 80) console.log(JSON.stringify({ event: event.event, shape: safeShape(event.data) }));
    const marker = `${event.event} ${event.data?.type || ''} ${event.data?.status || ''}`;
    if (/message_stop|turn_complete|response\.completed|turn_end/.test(marker)) break;
    if (event.event === 'rl' && event.data?.st === 'ok') break;
  }
} catch (error) {
  console.log(JSON.stringify({ stage: 'probe_end', error: error.name === 'AbortError' ? 'Diagnostic time limit reached.' : error.message }));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  controller.abort();
}
