import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
const { modal, configs, channels } = vi.hoisted(() => ({
  modal: vi.fn(),
  configs: ['A', 'B'].map((id) => ({
    id,
    identifier: 'max',
    name: `Bot ${id}`,
    enabled: true,
    isConfigured: true,
    version: 'v1',
  })),
  channels: [
    {
      identifier: 'max',
      providerConfigId: 'A',
      name: 'Channel A',
      disabled: false,
    },
    {
      identifier: 'max',
      providerConfigId: 'B',
      name: 'Channel B',
      disabled: false,
    },
  ],
}));
vi.mock('swr', () => ({
  default: (key: string) => ({
    data:
      key === '/channels/config'
        ? configs
        : key === '/integrations/list'
          ? channels
          : [{ identifier: 'max', name: 'MAX' }],
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('@postmill-ai/helpers/utils/custom.fetch', () => ({
  useFetch: () => vi.fn(),
}));
vi.mock('@postmill-ai/react/translation/get.transation.service.client', () => ({
  useT: () => (_k: string, fallback: string, values?: any) =>
    fallback?.replace('{{name}}', values?.name ?? ''),
}));
vi.mock('@postmill-ai/react/toaster/toaster', () => ({
  useToaster: () => ({ show: vi.fn() }),
}));
vi.mock('@postmill-ai/frontend/components/layout/new-modal', () => ({
  useModals: () => ({ openModal: modal }),
}));
vi.mock('@postmill-ai/frontend/components/layout/use-permissions', () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));
vi.mock('./channel-edit.modal', () => ({
  ChannelConfigForm: ({ config }: any) => <div>{config?.id}</div>,
}));
vi.mock('../shared/use-provider-catalog', () => ({
  useProviderCatalog: () => ({ data: [] }),
  latestActiveVersion: () => 'v1',
}));
vi.mock('../shared/provider-modal-title', () => ({ default: () => null }));
vi.mock('../shared/kit/provider-search-toolbar', () => ({
  ProviderSearchToolbar: () => null,
}));
vi.mock('@postmill-ai/frontend/components/shared/platform-icon', () => ({
  PlatformIcon: () => null,
}));
vi.mock('../shared/provider-list-shell', () => ({
  default: ({ providers, renderBadges, onRowClick }: any) => (
    <div>
      {providers.map((p: any) => (
        <div key={p.id} data-testid={p.id}>
          <button onClick={() => onRowClick(p)}>{p.name}</button>
          {renderBadges(p)}
        </div>
      ))}
    </div>
  ),
}));
import { ChannelsTab } from './channels.tab';
describe('MAX named channel configurations', () => {
  it('opens the selected second bot and shows only channels from that configuration', () => {
    render(<ChannelsTab />);
    expect(screen.getByTestId('A').textContent).toContain('Channel A');
    expect(screen.getByTestId('A').textContent).not.toContain('Channel B');
    expect(screen.getByTestId('B').textContent).toContain('Channel B');
    expect(screen.getByTestId('B').textContent).not.toContain('Channel A');
    fireEvent.click(screen.getByRole('button', { name: 'Bot B' }));
    render(modal.mock.calls.at(-1)![0].children(vi.fn()));
    expect(screen.getByText('B', { exact: true })).toBeTruthy();
  });
});
