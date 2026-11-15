// Synthetic fixtures: no live bot or channel data.
export const token = 'synthetic-max-bot-token';
export const chatId = '-123456';
export const bot = { user_id: 42, is_bot: true };
export const chat = {
  chat_id: -123456,
  type: 'channel',
  status: 'active',
  title: 'Synthetic channel',
};
export const member = {
  ...bot,
  is_owner: false,
  is_admin: true,
  permissions: ['post_edit_delete_message'],
};
export const sent = {
  message: {
    body: { mid: 'synthetic-mid' },
    url: 'https://max.ru/c/test/synthetic-mid',
  },
};
export const post = {
  id: 'postmill-internal-id',
  message: 'Hello MAX!\nSecond line.',
  settings: { __type: 'max' },
  media: [],
};
