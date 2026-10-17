import { inject, Module, type OnModuleInit } from '@knead-js/core';
import { type ListenOptions, WsRegistry, type WsSocket } from '@knead-js/http';

// #region tickets
/** One-time tickets that an authenticated HTTP endpoint hands to the browser. */
export class ChatTickets {
  readonly #tickets = new Map<string, { userId: string; expires: number }>();

  issue(userId: string): string {
    const ticket = crypto.randomUUID();
    this.#tickets.set(ticket, { userId, expires: Date.now() + 30_000 });
    return ticket;
  }

  redeem(ticket: string): string | undefined {
    const entry = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    return entry !== undefined && entry.expires > Date.now() ? entry.userId : undefined;
  }
}
// #endregion tickets

// #region endpoint
export interface ChatMember {
  userId: string;
}

function member(ws: WsSocket): ChatMember {
  return ws.data.data as ChatMember;
}

export class ChatGateway implements OnModuleInit {
  readonly #ws = inject(WsRegistry);
  readonly #tickets = inject(ChatTickets);

  onModuleInit(): void {
    this.#ws.register<ChatMember>(
      '/chat',
      {
        upgrade: (ctx) => {
          const ticket = ctx.query.ticket;
          const userId = typeof ticket === 'string' ? this.#tickets.redeem(ticket) : undefined;
          return userId === undefined ? false : { userId };
        },
        open: (ws) => {
          ws.subscribe('chat');
        },
        message: (ws, message) => {
          const text = typeof message === 'string' ? message : message.toString('utf8');
          ws.publish('chat', JSON.stringify({ from: member(ws).userId, text }));
        },
      },
      {
        allowedOrigins: ['https://app.example.com'],
        messageRate: { limit: 20, windowMs: 10_000 },
        maxConnectionLifetime: 60 * 60 * 1000,
      },
    );
  }

  /** Closes the sockets of a user who signed out; returns how many were closed. */
  signOut(userId: string): number {
    return this.#ws.closeWhere(
      (socket) => socket.data.endpoint === '/chat' && member(socket).userId === userId,
    );
  }
}

@Module({ providers: [ChatTickets, ChatGateway] })
export class ChatModule {}
// #endregion endpoint

// #region limits
export const chatListen: ListenOptions = {
  port: 8080,
  websocket: {
    maxPayloadLength: 16 * 1024,
    maxConnectionsPerIp: 20,
    maxConnections: 10_000,
  },
};
// #endregion limits
