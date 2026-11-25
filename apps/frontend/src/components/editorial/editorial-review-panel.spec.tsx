import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  EditorialReviewPanel, type EditorialReviewSnapshot,
} from './editorial-review-panel';

const commandId = '11111111-1111-4111-8111-111111111111';
const receipt = {
  status: 'queued/unconfirmed',
  dispatch_authorized: false,
  publishable: false,
};
const onCommand = vi.fn().mockResolvedValue(receipt);
const onRefresh = vi.fn().mockResolvedValue(undefined);

function snapshot(overrides: Partial<EditorialReviewSnapshot> = {}): EditorialReviewSnapshot {
  return {
    post_id: 'a'.repeat(32),
    task_id: '42',
    content: { title: 'Проверяемая история', parts: ['Начало', 'Середина', 'Финал'] },
    review_acknowledged: true,
    review: { status: 'idle', last_confirmed_state: { seq: '0', image_mode: 'disabled' } },
    remote_current_verified: false,
    dispatch_authorized: false,
    publishable: false,
    ...overrides,
  };
}

function show(data = snapshot()) {
  return render(
    <EditorialReviewPanel snapshot={data} onCommand={onCommand} onRefresh={onRefresh} />
  );
}

describe('Editorial 06B-4B dormant reviewer panel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    onCommand.mockResolvedValue(receipt);
    onRefresh.mockResolvedValue(undefined);
    vi.stubGlobal('crypto', { randomUUID: () => commandId });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders three full parts as text and never sends anything on mount', () => {
    show();
    expect(screen.getByText('Проверяемая история')).toBeTruthy();
    for (const part of ['Начало', 'Середина', 'Финал']) {
      expect(screen.getByText(part)).toBeTruthy();
    }
    expect(screen.getByText(/Черновик защищён от публикации/)).toBeTruthy();
    expect(screen.queryByText(/Опубликовать/)).toBeNull();
    expect(screen.queryByText(/Запланировать/)).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('uses distinguishable primary, secondary and danger button styles and native disabled state', () => {
    show();
    const approve = screen.getByRole('button', { name: 'Утвердить текст' });
    const revise = screen.getByRole('button', { name: 'Отправить на доработку' }) as HTMLButtonElement;
    const reject = screen.getByRole('button', { name: 'Отклонить материал' });
    const refresh = screen.getByRole('button', { name: /Проверить статус/ });
    expect(approve.classList.contains('bg-btnPrimary')).toBe(true);
    expect(revise.classList.contains('bg-btnSimple')).toBe(true);
    expect(revise.classList.contains('opacity-50')).toBe(true);
    expect(revise.disabled).toBe(true);
    expect(reject.classList.contains('bg-red-500/10')).toBe(true);
    expect(refresh.classList.contains('bg-btnSimple')).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('queues exactly the four allowed command keys, then blocks a second command', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Утвердить текст' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({
      command_id: commandId, expected_seq: '0', action: 'approve_text', feedback: '',
    }));
    await screen.findByText(/Это не подтверждение выполнения/);
    expect((screen.getByRole('button', { name: 'Утвердить текст' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Утвердить текст' }));
    fireEvent.click(screen.getByRole('button', { name: /Проверить статус/ }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects empty change feedback and sends trimmed feedback only on explicit click', async () => {
    show();
    const revise = screen.getByRole('button', { name: 'Отправить на доработку' });
    expect((revise as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Замечания к тексту'), {
      target: { value: '   ' },
    });
    expect((revise as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Замечания к тексту'), {
      target: { value: '  Уточнить доказательства  ' },
    });
    fireEvent.click(revise);
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({
      command_id: commandId, expected_seq: '0', action: 'request_text_changes',
      feedback: 'Уточнить доказательства',
    }));
  });

  it('requires an explicit second click to reject, and supports cancel', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить материал' }));
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('button', { name: 'Подтвердить отклонение' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить материал' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить отклонение' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({
      command_id: commandId, expected_seq: '0', action: 'reject', feedback: '',
    }));
  });

  it('shows image request only for manual-image review mode', async () => {
    const view = show();
    expect(screen.queryByRole('button', { name: 'Запросить изображение' })).toBeNull();
    view.rerender(
      <EditorialReviewPanel
        snapshot={snapshot({ review: {
          status: 'idle', last_confirmed_state: { seq: '0', image_mode: 'manual' },
        } })}
        onCommand={onCommand}
        onRefresh={onRefresh}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Запросить изображение' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith({
      command_id: commandId, expected_seq: '0', action: 'request_image', feedback: '',
    }));
  });

  it('shows explicit mock import and blocks repeating an unknown storage operation', async () => {
    const onImportImage=vi.fn().mockRejectedValue(new Error('unknown'));
    const data=snapshot({mock_image:{status:'waiting',can_import:true,asset:null},
      review:{status:'idle',last_confirmed_state:{seq:'0',image_mode:'automatic'}}});
    render(<EditorialReviewPanel snapshot={data} onCommand={onCommand} onRefresh={onRefresh} onImportImage={onImportImage}/>);
    const button=screen.getByRole('button',{name:'Получить изображение'});
    expect(onImportImage).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByText(/Результат импорта неизвестен/);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onImportImage).toHaveBeenCalledExactlyOnceWith('0');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('fails closed on pending review, missing snapshot, incomplete parts or unsafe flags', () => {
    const scenarios: EditorialReviewSnapshot[] = [
      snapshot({ review: { status: 'pending', last_confirmed_state: { seq: '0' } } }),
      snapshot({ review_acknowledged: false }),
      snapshot({ content: { title: 'Broken', parts: ['one', 'two'] } }),
      snapshot({ review: null }),
      snapshot({ publishable: true as false }),
    ];
    for (const state of scenarios) {
      const mounted = show(state);
      expect((screen.getByRole('button', { name: 'Утвердить текст' }) as HTMLButtonElement).disabled)
        .toBe(true);
      mounted.unmount();
    }
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('does not automatically retry a failed/unknown decision after read-only refresh', async () => {
    onCommand.mockRejectedValueOnce(new Error('HTTP response unknown'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Утвердить текст' }));
    await screen.findByText(/Результат отправки неизвестен/);
    fireEvent.click(screen.getByRole('button', { name: /Проверить статус/ }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: 'Утвердить текст' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it('blocks decisions during revision import and after terminal rejection', () => {
    const first = show(snapshot({ review: { status: 'idle', last_confirmed_state: {
      seq: '1', image_mode: 'disabled', text_status: 'changes_requested',
    } } }));
    expect((screen.getByRole('button', { name: 'Утвердить текст' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Отклонить материал' }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();
    show(snapshot({ review: { status: 'idle', last_confirmed_state: {
      seq: '2', image_mode: 'disabled', rejected: true,
    } } }));
    expect((screen.getByRole('button', { name: 'Утвердить текст' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('unlocks only when a newly confirmed sequence arrives from the server', async () => {
    const mounted = show();
    fireEvent.click(screen.getByRole('button', { name: 'Утвердить текст' }));
    await screen.findByText(/Решение поставлено в очередь/);
    const approve = screen.getByRole('button', { name: 'Утвердить текст' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    mounted.rerender(
      <EditorialReviewPanel snapshot={snapshot({
        review: { status: 'idle', last_confirmed_state: { seq: '1', image_mode: 'disabled' } },
      })} onCommand={onCommand} onRefresh={onRefresh} />
    );
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    expect(onCommand).toHaveBeenCalledTimes(1);
  });
});


describe('live JPEG preview UI boundary', () => {
  it('revokes the local object URL when the confirmed sequence changes', async () => {
    const create = vi.fn().mockReturnValue('blob:editorial-preview');
    const revoke = vi.fn();
    const OriginalURL = URL;
    vi.stubGlobal('URL', class extends OriginalURL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    });
    const load = vi.fn().mockResolvedValueOnce(new Blob(['jpeg'], { type: 'image/jpeg' })).mockImplementation(() => new Promise<Blob>(() => undefined));
    const data = (seq: string) => snapshot({
      live_image_preview_enabled: true,
      review: { status: 'idle', last_confirmed_state: {
        seq, rejected: false, image: { revision: 1, sha256: 'a'.repeat(64) },
      } },
    });
    const props = { onCommand, onRefresh, onPreviewLiveImage: load };
    try {
      const view = render(<EditorialReviewPanel {...props} snapshot={data('8')} />);
      const image = await screen.findByRole('img', { name: 'Иллюстрация редакции' });
      expect(image.getAttribute('src')).toBe('blob:editorial-preview');
      view.rerender(<EditorialReviewPanel {...props} snapshot={data('9')} />);
      expect(screen.queryByRole('img', { name: 'Иллюстрация редакции' })).toBeNull();
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:editorial-preview');
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      view.unmount();
    } finally { vi.unstubAllGlobals(); }
  });

  it('automatically loads only a current opted-in image', async () => {
    const load = vi.fn().mockRejectedValue(new Error('revoked'));
    const data = snapshot({
      live_image_preview_enabled: true,
      review: { status: 'idle', last_confirmed_state: {
        seq: '8', rejected: false, image: { revision: 1, sha256: 'a'.repeat(64) },
      } },
    });
    const props = { onCommand, onRefresh, onPreviewLiveImage: load };
    const view = render(<EditorialReviewPanel {...props} snapshot={snapshot()} />);
    expect(screen.queryByRole('region', { name: 'Предпросмотр реальной иллюстрации' })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    view.rerender(<EditorialReviewPanel {...props} snapshot={data} />);
    await screen.findByText('Не удалось подтвердить доступ к изображению. Проверь статус.');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toBe('8');
    expect(screen.queryByRole('img', { name: 'Иллюстрация редакции' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Утвердить текст и изображение' })).toBeNull();
    view.rerender(<EditorialReviewPanel {...props} snapshot={data} mutationsBlocked />);
    expect(screen.queryByRole('region', { name: 'Предпросмотр реальной иллюстрации' })).toBeNull();
  });
});


describe('live JPEG import and approval controls', () => {
  it('never imports on mount and blocks an uncertain import from repeating', async () => {
    const load=vi.fn().mockRejectedValue(new Error('unexpected preview'));
    const importImage=vi.fn().mockRejectedValue(new Error('unknown'));
    const data=snapshot({live_image_preview_enabled:true,live_image_mutations_enabled:true,
      review:{status:'idle',last_confirmed_state:{seq:'8',rejected:false,final_approved:false,
        image_mode:'automatic',text_status:'approved',image_compatible:false,image_intent:'request-1'}}});
    render(<EditorialReviewPanel snapshot={data} onCommand={onCommand} onRefresh={onRefresh}
      onPreviewLiveImage={load} onImportImage={importImage}/>);
    expect(importImage).not.toHaveBeenCalled();
    const button=screen.getByRole('button',{name:'Получить изображение'});
    fireEvent.click(button);
    await screen.findByText(/Результат импорта неизвестен/);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(importImage).toHaveBeenCalledExactlyOnceWith('8');
    expect(load).not.toHaveBeenCalled();
  });
  it('offers final approval only after the automatically loaded image decodes', async () => {
    const OriginalURL=URL;
    vi.stubGlobal('URL',class extends OriginalURL {
      static createObjectURL=vi.fn().mockReturnValue('blob:editorial-live');
      static revokeObjectURL=vi.fn();
    });
    vi.stubGlobal('crypto',{randomUUID:()=>commandId});
    const command=vi.fn().mockResolvedValue(receipt);
    const load=vi.fn().mockResolvedValue(new Blob(['jpeg'],{type:'image/jpeg'}));
    const data=snapshot({live_image_preview_enabled:true,live_image_mutations_enabled:true,
      review:{status:'idle',last_confirmed_state:{seq:'9',rejected:false,final_approved:false,
        image_mode:'automatic',text_status:'approved',image_compatible:true,image_intent:null,
        image:{revision:1,sha256:'a'.repeat(64)}}}});
    try {
      const view=render(<EditorialReviewPanel snapshot={data} onCommand={command} onRefresh={onRefresh}
        onPreviewLiveImage={load}/>);
      const img=await screen.findByRole('img',{name:'Иллюстрация редакции'});
      expect(screen.queryByRole('button',{name:'Утвердить текст и изображение'})).toBeNull();
      fireEvent.load(img);
      const approve=screen.getByRole('button',{name:'Утвердить текст и изображение'});
      fireEvent.click(approve);
      await waitFor(()=>expect(command).toHaveBeenCalledExactlyOnceWith({
        command_id:commandId,expected_seq:'9',action:'approve_final',feedback:'',
      }));
      view.unmount();
    } finally {vi.unstubAllGlobals();}
  });
});
