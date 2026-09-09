import { clientId, scope } from './auth.mjs';

// A terminated launcher must not leave an authentication helper behind.
if (process.send) process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'));

// Only the launcher may request authentication from this helper. Access tokens
// are delivered solely through its private IPC channel; stdio stays empty.
if (process.send) process.once('message', async options => {
  try {
    const { InteractiveBrowserCredential, useIdentityPlugin } = await import('@azure/identity');
    const { nativeBrokerPlugin } = await import('@azure/identity-broker');
    useIdentityPlugin(nativeBrokerPlugin);
    const credential = new InteractiveBrowserCredential({
      clientId, tenantId: options.tenantId, authorityHost: 'https://login.microsoftonline.com',
      authenticationRecord: options.interactive ? undefined : options.record,
      brokerOptions: {
        enabled: true, useDefaultBrokerAccount: !options.interactive,
        // A CLI has no owned GUI window. HWND(0) gives the system dialog an
        // unowned desktop window, while silent WAM requests need no window.
        parentWindowHandle: Buffer.alloc(process.arch === 'ia32' ? 4 : 8),
      },
    });
    const token = await credential.getToken(scope);
    const record = await credential.authenticate(scope);
    process.send({ type: 'token', token: token.token, record });
  } catch (error) {
    const aadsts = /AADSTS\d+/.exec(String(error.message))?.[0];
    const label = String(error.errorCode || error.code || error.name || 'authentication_error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    process.send({ type: 'error', code: aadsts || label });
  }
});
