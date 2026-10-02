import { describe, expect, it, vi } from 'vitest';
import { MessagingService } from './messaging.service';
import { Role } from '../../shared/enums';

describe('Conversation list order', () => {
  it('asks for threads with recent messages first and never-used threads last', async () => {
    const conversationRepo = {
      find: vi.fn().mockResolvedValue([]),
      manager: { query: vi.fn().mockResolvedValue([]) },
    };
    const service = new MessagingService(conversationRepo as never, {} as never);
    await service.listMyConversations({ id: 'c1', role: Role.CUSTOMER });
    expect(conversationRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      order: { lastMessageAt: { direction: 'DESC', nulls: 'LAST' }, createdAt: 'DESC' },
    }));
  });
});
