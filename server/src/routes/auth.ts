import express from 'express';
import { client, Api, ensureClient, saveCurrentSession, setClientReady } from '../telegram';
import { API_ID, API_HASH } from '../config';

export function registerAuthRoutes(app: express.Express) {
  app.post('/auth/start', async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).send('phone required');
    try {
      await client.connect();
      const result: any = await client.invoke(new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: Number(API_ID),
        apiHash: API_HASH,
        settings: new Api.CodeSettings({})
      }));
      (global as any)._phone = phone;
      (global as any)._phone_code_hash = result.phone_code_hash || result.phoneCodeHash || result.phoneCodeHash;
      res.send('code_sent');
    } catch (err) {
      console.error('auth start error', err);
      res.status(500).send('failed');
    }
  });

  app.post('/auth/verify', async (req, res) => {
    const { code } = req.body || {};
    const phone = (global as any)._phone;
    const phone_code_hash = (global as any)._phone_code_hash;
    if (!phone || !phone_code_hash) return res.status(400).send('start not called');
    try {
      const result: any = await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: phone_code_hash,
        phoneCode: code
      }));
      saveCurrentSession();
      setClientReady(true);
      res.send('ok');
    } catch (err: any) {
      console.error('verify error', err);
      if (err.code === 401 && err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        const { password } = req.body || {};
        if (!password) return res.status(400).send('password required');
        try {
          const pw = await client.invoke(new Api.account.GetPassword());
          const compute = require('telegram/Password').computeCheck;
          const inputCheck = await compute(pw, password);
          const sign = await client.invoke(new Api.auth.CheckPassword({ password: inputCheck }));
          saveCurrentSession();
          setClientReady(true);
          return res.send('ok');
        } catch (pwerr) {
          console.error('password verify error', pwerr);
          return res.status(500).send('password failed');
        }
      }
      res.status(500).send('failed');
    }
  });
}
