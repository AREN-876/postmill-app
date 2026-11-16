import 'reflect-metadata';
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExistingDataContextProvider } from '@postmill-ai/frontend/components/launches/helpers/use.existing.data';
import { Composer } from './composer';
import { useLaunchStore } from './store';
import { STORYGO_DIVIDER } from '@postmill-ai/provider-kernel/domains/max-story';

vi.mock('@postmill-ai/helpers/utils/custom.fetch', () => ({
  useFetch: () => vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@postmill-ai/frontend/components/composer/manage.modal', () => ({
  ManageModal: () => null,
}));

vi.mock('@postmill-ai/frontend/components/layout/loading', () => ({
  LoadingComponent: () => null,
}));

const channel = {
  id: 'channel-1',
  identifier: 'x',
  name: 'Test channel',
  additionalSettings: '[]',
  editor: 'normal',
} as any;

const existingData = {
  integration: channel.id,
  settings: {},
  posts: [
    {
      id: 'post-1',
      content: 'Loaded existing content',
      delay: 0,
      image: [],
      tags: [],
    },
  ],
};

const renderComposer = (data = existingData, selected = channel) =>
  render(
    <ExistingDataContextProvider value={data}>
      <Composer allIntegrations={[selected]} integrations={[selected]} />
    </ExistingDataContextProvider>
  );

const expectLoadedPost = async () => {
  await waitFor(() => {
    expect(useLaunchStore.getState().internal).toEqual([
      expect.objectContaining({
        integration: channel,
        integrationValue: [
          expect.objectContaining({
            id: 'post-1',
            content: '<p>Loaded existing content</p>',
          }),
        ],
      }),
    ]);
  });
};

describe('Composer existing-data initialization', () => {
  beforeEach(() => {
    useLaunchStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useLaunchStore.getState().reset();
  });

  it('opens an existing MAX story as one editable text and clears legacy continuation state', async () => {
    const maxChannel = { ...channel, identifier: 'max' };
    const data = {
      ...existingData,
      settings: { mode: 'story', continuationText: 'Вторая\n' + STORYGO_DIVIDER + '\nФинал' },
      posts: [{ ...existingData.posts[0], content: 'Заголовок\nНачало' }],
    };
    renderComposer(data, maxChannel);
    await waitFor(() => {
      const state = useLaunchStore.getState();
      expect(state.internal[0]?.integrationValue[0]?.content).toBe(
        ['Заголовок', 'Начало', STORYGO_DIVIDER, 'Вторая', STORYGO_DIVIDER, 'Финал']
          .map((line) => `<p>${line}</p>`).join('')
      );
      expect(state.selectedIntegrations[0]?.settings.continuationText).toBe('');
    });
  });

  it('preserves loaded posts when the store is cold', async () => {
    renderComposer();

    await expectLoadedPost();
    expect(useLaunchStore.getState().selectedIntegrations).toHaveLength(1);
  });

  it('preserves loaded posts when a stale selection mounts the editor first', async () => {
    useLaunchStore
      .getState()
      .addOrRemoveSelectedIntegration({ ...channel, id: 'channel-2' }, {});

    renderComposer();

    await expectLoadedPost();
    expect(
      useLaunchStore
        .getState()
        .selectedIntegrations.some((item) => item.integration.id === channel.id)
    ).toBe(true);
  });
});
