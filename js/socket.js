import { ensureAccessToken, getApiBaseUrl } from "./api.js";

export class ChatSocket {
  constructor({ onConnected, onListEvent, onRoomEvent, onUserMetadataEvent, onError, onAuthFailure }) {
    this.callbacks = { onConnected, onListEvent, onRoomEvent, onUserMetadataEvent, onError, onAuthFailure };
    this.client = null;
    this.roomSubscription = null;
    this.desiredRoomId = null;
  }

  connect() {
    if (!window.SockJS || !window.StompJs) {
      this.callbacks.onError({ message: "실시간 통신 라이브러리를 불러오지 못했습니다." });
      return;
    }

    this.client = new window.StompJs.Client({
      webSocketFactory: () => new window.SockJS(`${getApiBaseUrl()}/ws`),
      reconnectDelay: 3000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      beforeConnect: async () => {
        try {
          const token = await ensureAccessToken();
          this.client.connectHeaders = { Authorization: `Bearer ${token}` };
        } catch (error) {
          this.callbacks.onAuthFailure(error);
          throw error;
        }
      },
      onConnect: () => {
        this.client.subscribe("/user/queue/errors", (frame) => {
          const error = this.parseFrame(frame);
          this.callbacks.onError(error || { message: "실시간 요청을 처리하지 못했습니다." });
        });
        this.client.subscribe("/user/queue/chatRooms/list", (frame) => {
          const event = this.parseFrame(frame);
          if (event) this.callbacks.onListEvent(event);
        });
        this.client.subscribe("/user/queue/users/metadata", (frame) => {
          const event = this.parseFrame(frame);
          if (event) this.callbacks.onUserMetadataEvent(event);
        });
        this.subscribeDesiredRoom();
        this.callbacks.onConnected();
      },
      onStompError: (frame) => {
        const body = this.parseFrame(frame);
        this.callbacks.onError(body || {
          message: frame.headers?.message || "실시간 연결 오류가 발생했습니다."
        });
      },
      onWebSocketError: () => {
        this.callbacks.onError({ message: "실시간 연결을 확인하고 있습니다.", transient: true });
      }
    });

    this.client.activate();
  }

  parseFrame(frame) {
    try {
      return JSON.parse(frame.body);
    } catch {
      return null;
    }
  }

  subscribeRoom(roomId) {
    this.desiredRoomId = roomId;
    this.subscribeDesiredRoom();
  }

  subscribeDesiredRoom() {
    this.roomSubscription?.unsubscribe();
    this.roomSubscription = null;

    if (!this.desiredRoomId || !this.client?.connected) {
      return;
    }

    this.roomSubscription = this.client.subscribe(`/topic/chatRooms/${this.desiredRoomId}`, (frame) => {
      const event = this.parseFrame(frame);
      if (event) this.callbacks.onRoomEvent(event);
    });
  }

  unsubscribeRoom() {
    this.desiredRoomId = null;
    this.roomSubscription?.unsubscribe();
    this.roomSubscription = null;
  }

  sendMessage(roomId, content) {
    this.publish(`/app/chatRooms/${roomId}/message`, { content });
  }

  sendRead(roomId, readMessageId) {
    this.publish(`/app/chatRooms/${roomId}/read`, { readMessageId });
  }

  publish(destination, body) {
    if (!this.client?.connected) {
      throw new Error("실시간 연결이 끊어져 있습니다.");
    }

    this.client.publish({ destination, body: JSON.stringify(body) });
  }

  disconnect() {
    this.unsubscribeRoom();
    return this.client?.deactivate();
  }
}
