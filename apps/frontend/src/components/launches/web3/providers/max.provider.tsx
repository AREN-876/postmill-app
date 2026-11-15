'use client';
import React, { FC, useState } from 'react';
import { Web3ProviderInterface } from '../web3.provider.interface';
import { Input } from '@postmill-ai/react/form/input';
import { Button } from '@postmill-ai/react/form/button';
import { useT } from '@postmill-ai/react/translation/get.transation.service.client';

export const MaxProvider: FC<Web3ProviderInterface> = ({
  nonce,
  onComplete,
}) => {
  const t = useT();
  const [chatId, setChatId] = useState('');
  const valid =
    /^-?[1-9][0-9]{0,18}$/.test(chatId) &&
    BigInt(chatId) >= BigInt('-9223372036854775808') &&
    BigInt(chatId) <= BigInt('9223372036854775807');
  return (
    <div className="flex flex-col gap-3">
      <p>
        {t(
          'max_chat_id_help',
          'Enter the test channel chat_id from a bot_added event or channel update. The bot must be an administrator with posting rights. No message is sent when connecting.',
        )}
      </p>
      <Input
        disableForm
        name="max-chat-id"
        aria-label={t('max_channel_id', 'MAX channel chat_id')}
        label={t('max_channel_id', 'MAX channel chat_id')}
        value={chatId}
        onChange={(e) => setChatId(e.target.value.trim())}
        autoComplete="off"
      />
      <Button
        disabled={!valid}
        onClick={() => valid && onComplete(chatId, nonce)}
      >
        {t('max_validate_channel', 'Validate test channel')}
      </Button>
    </div>
  );
};
