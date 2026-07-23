/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { Banner, Button, Input, Switch } from '@douyinfe/semi-ui-19';
import { useState } from 'react';
import { xhrPost } from '../../../../../services/xhr.js';
import { useTranslation } from '../../../../../services/i18n/i18n.jsx';

const emptyTelegram = {
  id: 'telegram',
  name: 'Telegram',
  fields: {
    token: '',
    chatId: '',
    messageThreadId: '',
    plainText: false,
  },
};

export default function TelegramSettings({ value, onChange }) {
  const t = useTranslation();
  const telegram = value?.id === 'telegram' ? value : emptyTelegram;
  const fields = { ...emptyTelegram.fields, ...(telegram.fields || {}) };
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const update = (key, nextValue) => {
    onChange({
      id: 'telegram',
      name: 'Telegram',
      fields: { ...fields, [key]: nextValue },
    });
    setResult(null);
  };

  const testTelegram = async () => {
    if (!fields.token?.trim() || !fields.chatId?.trim()) {
      setResult({ type: 'danger', message: t('notification.telegramRequired') });
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      await xhrPost('/api/jobs/telegram/test', { fields });
      setResult({ type: 'success', message: t('notification.trySuccess') });
    } catch (error) {
      setResult({
        type: 'danger',
        message: t('notification.tryError', { error: error?.json?.error || error?.message || 'Unknown error' }),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="jobMutation__telegram">
      <Input
        type="password"
        value={fields.token}
        placeholder={t('notification.telegramToken')}
        onChange={(next) => update('token', next)}
      />
      <Input
        value={fields.chatId}
        placeholder={t('notification.telegramChatId')}
        onChange={(next) => update('chatId', next)}
      />
      <Input
        value={fields.messageThreadId}
        placeholder={t('notification.telegramThreadId')}
        onChange={(next) => update('messageThreadId', next)}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Switch checked={Boolean(fields.plainText)} onChange={(next) => update('plainText', next)} />
        {t('notification.telegramPlainText')}
      </label>
      {result && <Banner fullMode={false} type={result.type} closeIcon={null} description={result.message} />}
      <Button loading={testing} onClick={testTelegram}>
        {t('notification.try')}
      </Button>
    </div>
  );
}
