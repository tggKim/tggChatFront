const API_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? "http://localhost:8080"
  : "";

let refreshPromise = null;
let sessionInvalidated = false;
const sessionAbortController = new AbortController();

export class ApiError extends Error {
  constructor(message, status = 0, code = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const getApiBaseUrl = () => API_BASE_URL;

export const getAccessToken = () => sessionStorage.getItem("accessToken");

export const clearAccessToken = () => sessionStorage.removeItem("accessToken");

export const invalidateSession = () => {
  if (sessionInvalidated) return;
  sessionInvalidated = true;
  clearAccessToken();
  sessionAbortController.abort();
};

const throwIfSessionInvalidated = () => {
  if (!sessionInvalidated) return;
  const error = new Error("현재 페이지의 로그인 세션이 종료되었습니다.");
  error.name = "AbortError";
  throw error;
};

const createRequestSignal = (externalSignal) => {
  if (!externalSignal) {
    return { signal: sessionAbortController.signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal.addEventListener("abort", abort, { once: true });
  sessionAbortController.signal.addEventListener("abort", abort, { once: true });

  if (externalSignal.aborted || sessionAbortController.signal.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      externalSignal.removeEventListener("abort", abort);
      sessionAbortController.signal.removeEventListener("abort", abort);
    }
  };
};

const parseResponse = async (response) => {
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : null;
};

const refreshAccessToken = async () => {
  throwIfSessionInvalidated();
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    let response;

    try {
      response = await fetch(`${API_BASE_URL}/refresh`, {
        method: "POST",
        credentials: "include",
        signal: sessionAbortController.signal
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new ApiError("서버에 연결할 수 없습니다.");
    }

    const body = await parseResponse(response);
    throwIfSessionInvalidated();
    if (!response.ok || !body?.accessToken) {
      clearAccessToken();
      throw new ApiError(body?.message || "로그인이 만료되었습니다.", response.status, body?.code);
    }

    sessionStorage.setItem("accessToken", body.accessToken);
    return body.accessToken;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
};

const decodeExpiration = (token) => {
  try {
    const payload = token.split(".")[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(padded)).exp ?? 0;
  } catch {
    return 0;
  }
};

export const ensureAccessToken = async () => {
  throwIfSessionInvalidated();
  const token = getAccessToken();

  if (!token) {
    throw new ApiError("로그인이 필요합니다.", 401);
  }

  const expiresAt = decodeExpiration(token) * 1000;

  if (expiresAt > Date.now() + 30_000) {
    return token;
  }

  return refreshAccessToken();
};

export const request = async (path, options = {}, retryAfterRefresh = true) => {
  throwIfSessionInvalidated();
  const token = options.auth === false ? null : await ensureAccessToken();
  throwIfSessionInvalidated();
  const requestSignal = createRequestSignal(options.signal);

  try {
    let response;

    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method: options.method || "GET",
        credentials: "include",
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: requestSignal.signal,
        headers: {
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers
        }
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }
      throw new ApiError("서버에 연결할 수 없습니다.");
    }

    throwIfSessionInvalidated();

    if (response.status === 401 && retryAfterRefresh && options.auth !== false) {
      await refreshAccessToken();
      return request(path, options, false);
    }

    const body = await parseResponse(response);
    throwIfSessionInvalidated();
    if (!response.ok) {
      throw new ApiError(body?.message || "요청을 처리하는 중 오류가 발생했습니다.", response.status, body?.code);
    }

    return body;
  } finally {
    requestSignal.cleanup();
  }
};

export const api = {
  getMe: () => request("/me"),
  updateMe: (username) => request("/me", { method: "PATCH", body: { username } }),
  logout: () => request("/logout", { method: "POST" }),

  getFriends: () => request("/friends"),
  addFriend: (username) => request("/friends", { method: "POST", body: { username } }),

  getChatRooms: () => request("/chatRooms"),
  createDirectRoom: (friendId) => request("/directChatRooms", {
    method: "POST",
    body: { friendId }
  }),
  createGroupRoom: (friendIds, chatRoomName) => request("/groupChatRooms", {
    method: "POST",
    body: { friendIds, chatRoomName: chatRoomName || null }
  }),
  getInvitableFriends: (roomId) => request(`/chatRooms/${roomId}/invitableFriends`),
  inviteToDirectRoom: (roomId, friendIds) => request(`/directChatRooms/${roomId}/invites`, {
    method: "POST",
    body: { friendIds }
  }),
  inviteToGroupRoom: (roomId, friendIds) => request(`/groupChatRooms/${roomId}/invites`, {
    method: "POST",
    body: { friendIds }
  }),
  getRoomMembers: (roomId) => request(`/chatRooms/${roomId}/members`),
  getMessages: (roomId, offsetMessageId = null, signal) => {
    const query = offsetMessageId == null ? "" : `?offsetMessageId=${offsetMessageId}`;
    return request(`/chatRooms/${roomId}/messages${query}`, { signal });
  },
  getReadStatuses: (roomId, signal) => request(`/chatRooms/${roomId}/readStatuses`, { signal }),
  updateBaseRoomName: (roomId, roomName) => request(`/chatRooms/${roomId}/name`, {
    method: "PATCH",
    body: { roomName }
  }),
  updateCustomRoomName: (roomId, customRoomName) => request(`/chatRooms/${roomId}/customName`, {
    method: "PATCH",
    body: { customRoomName }
  }),
  leaveRoom: (roomId, nextOwnerId) => request(`/chatRooms/${roomId}/leave`, {
    method: "POST",
    body: { nextOwnerId: nextOwnerId ?? null }
  })
};
