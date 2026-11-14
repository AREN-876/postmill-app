import { ProviderMetadata } from '@postmill-ai/provider-kernel';
export const metadata: ProviderMetadata = {
  id: 'max',
  displayName: 'MAX',
  kind: 'action',
  domains: [],
  hasModelList: false,
  website: 'https://max.ru',
  docsUrl: 'https://dev.max.ru/docs-api',
  description: {
    en: 'MAX bot channel. Text only; live sandbox verification pending.',
    ru: 'Канал MAX через бота. Только текст; проверка на тестовом канале ещё не выполнена.',
  },
};
