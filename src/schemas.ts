import { z } from 'zod';

export const conversationIdSchema = z.string().uuid();
export const createConversationSchema = z.object({ model: z.string().min(1).max(100).optional() }).default({});
export const chatSchema = z.object({
  conversationId: conversationIdSchema,
  message: z.string().min(1).max(100_000),
  model: z.string().min(1).max(100).optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).default([])
});
export const conversationMessageSchema = chatSchema.omit({ conversationId: true });
