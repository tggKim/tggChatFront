import { api, clearAccessToken } from "./api.js";
import { ChatSocket } from "./socket.js";

const root = document.getElementById("chat-layout-wireframe");
const $ = (selector) => root.querySelector(selector);
const $$ = (selector) => [...root.querySelectorAll(selector)];

const state = {
  me: null,
  friends: [],
  rooms: new Map(),
  selectedRoomId: null,
  messages: [],
  readStates: new Map(),
  members: [],
  selectedFriend: null,
  editTarget: null,
  roomListSyncing: false,
  roomListSyncPromise: null,
  pendingRoomListEvents: [],
  roomSyncing: false,
  pendingRoomEvents: [],
  roomLoadVersion: 0,
  roomAbortController: null,
  readTimer: null,
  membershipRefreshTimer: null,
  membershipRefreshVersion: 0,
  detailLoadVersion: 0,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  hasConnected: false
};

const dom = {
  sidebarTitle: $("#cw-sidebar-title"),
  chatList: $("#cw-chat-list-view"),
  friendList: $("#cw-friend-list-view"),
  settings: $("#cw-settings-view"),
  newChatButton: $("#cw-new-chat-button"),
  addFriendButton: $("#cw-add-friend-button"),
  emptyRoom: $("#cw-empty-room"),
  activeRoom: $("#cw-active-room"),
  headerAvatars: $("#cw-room-header-avatars"),
  headerName: $("#cw-room-header-name"),
  headerCount: $("#cw-room-header-count"),
  messages: $("#cw-messages"),
  composer: $("#cw-composer"),
  messageInput: $("#cw-message-input"),
  namePopover: $("#cw-name-popover"),
  detailPanel: $("#cw-detail-panel"),
  memberList: $("#cw-member-list"),
  detailTitle: $("#cw-detail-title"),
  messageDialog: $("#cw-message-dialog"),
  messageDialogText: $("#cw-message-dialog-text"),
  messageDialogConfirm: $("#cw-message-dialog-confirm")
};

const sidebarViews = {
  friends: dom.friendList,
  chats: dom.chatList,
  settings: dom.settings
};

const sidebarTabs = {
  friends: $("#cw-friends-tab"),
  chats: $("#cw-chats-tab"),
  settings: $("#cw-settings-tab")
};

let messageDialogAction = null;

const createElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

const toNumber = (value) => value == null ? null : Number(value);

const initial = (username) => username?.trim()?.[0] || "?";

const renderIcons = () => {
  if (window.lucide) window.lucide.createIcons({ attrs: { width: 16, height: 16 } });
};

const setAvatar = (avatar, username, profileImageKey) => {
  avatar.replaceChildren();
  avatar.setAttribute("aria-label", `${username || "알 수 없는 사용자"} 프로필 이미지`);

  if (profileImageKey) {
    avatar.dataset.profileImageKey = profileImageKey;
    avatar.classList.remove("cw-avatar-default");
    avatar.textContent = initial(username);
    return avatar;
  }

  delete avatar.dataset.profileImageKey;
  avatar.classList.add("cw-avatar-default");
  const icon = createElement("i", "cw-avatar-default-icon");
  icon.setAttribute("data-lucide", "user-round");
  icon.setAttribute("aria-hidden", "true");
  avatar.append(icon);
  return avatar;
};

const createAvatar = (username, profileImageKey, extraClass = "") => {
  const avatar = createElement("span", `cw-avatar ${extraClass}`.trim());
  return setAvatar(avatar, username, profileImageKey);
};

const displayRoomName = (room) => {
  if (room.customRoomName) return room.customRoomName;
  if (room.baseRoomName) return room.baseRoomName;
  const names = room.previewUsers.map((user) => user.username).filter(Boolean);
  if (names.length) return names.join(", ");
  return room.roomType === "DIRECT" ? "?" : "";
};

const formatActivityTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" }).format(date);
};

const formatMessageTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(date);
};

const normalizePreviewUsers = (users) => Array.isArray(users)
  ? users.slice(0, 4).map((user) => ({
      userId: toNumber(user.userId),
      username: user.username ?? "알 수 없는 사용자",
      profileImageKey: user.profileImageKey ?? null
    }))
  : [];

const normalizeRoom = (room) => ({
  roomId: toNumber(room.roomId),
  roomType: room.roomType ?? null,
  baseRoomName: room.baseRoomName ?? null,
  customRoomName: room.customRoomName ?? null,
  myRole: room.myRole ?? null,
  memberCount: toNumber(room.memberCount) ?? 0,
  previewUsers: normalizePreviewUsers(room.previewUsers),
  lastMessagePreview: room.lastMessagePreview ?? null,
  messageId: toNumber(room.messageId),
  lastActivityAt: room.lastActivityAt ?? null,
  unreadStartMessageId: toNumber(room.unreadStartMessageId),
  unreadCount: toNumber(room.unreadCount) ?? 0
});

const normalizeMessage = (message) => ({
  messageId: toNumber(message.messageId),
  chatMessageType: message.chatMessageType ?? "TEXT",
  content: message.content ?? "",
  senderId: toNumber(message.senderId),
  senderName: message.senderName ?? null,
  senderProfileImageKey: message.senderProfileImageKey ?? null,
  createdAt: message.createdAt ?? null
});

const renderAvatarStack = (container, room, large = false) => {
  container.replaceChildren();
  room.previewUsers.forEach((user) => {
    container.append(createAvatar(user.username, user.profileImageKey, large ? "cw-avatar-large" : ""));
  });

  const hiddenUserCount = Math.max(0, room.memberCount - 1 - room.previewUsers.length);
  if (hiddenUserCount > 0) {
    const overflow = createElement(
      "span",
      `cw-avatar cw-avatar-overflow${large ? " cw-avatar-large" : ""}`,
      `외${hiddenUserCount}`
    );
    container.append(overflow);
  }

  if (!container.childElementCount) {
    container.append(createAvatar("?", null, large ? "cw-avatar-large" : ""));
  }
  renderIcons();
};

const sortedRooms = () => [...state.rooms.values()].sort((left, right) => {
  const timeDifference = new Date(right.lastActivityAt || 0) - new Date(left.lastActivityAt || 0);
  return timeDifference || right.roomId - left.roomId;
});

const renderRoomList = () => {
  dom.chatList.replaceChildren();
  const rooms = sortedRooms();
  if (!rooms.length) {
    dom.chatList.append(createElement("div", "cw-list-state", "참여 중인 채팅방이 없습니다."));
    return;
  }

  rooms.forEach((room) => {
    const row = createElement("button", "cw-room-row");
    row.type = "button";
    row.classList.toggle("is-selected", room.roomId === state.selectedRoomId);
    row.setAttribute("aria-pressed", String(room.roomId === state.selectedRoomId));
    row.addEventListener("click", () => openRoom(room.roomId));

    const avatars = createElement("span", "cw-avatar-stack");
    renderAvatarStack(avatars, room);

    const copy = createElement("span", "cw-room-copy");
    const titleLine = createElement("span", "cw-room-title-line");
    titleLine.append(createElement("span", "cw-room-title", displayRoomName(room)));
    if (room.roomType === "GROUP") {
      titleLine.append(createElement("span", "cw-room-count text-small", String(room.memberCount)));
    }
    copy.append(titleLine);
    copy.append(createElement("span", "cw-preview text-small", room.lastMessagePreview || "메시지가 없습니다."));

    const meta = createElement("span", "cw-room-meta");
    meta.append(createElement("span", "cw-time text-small", formatActivityTime(room.lastActivityAt)));
    if (room.unreadCount > 0) {
      meta.append(createElement("span", "cw-unread-badge", room.unreadCount > 999 ? "999+" : String(room.unreadCount)));
    }

    row.append(avatars, copy, meta);
    dom.chatList.append(row);
  });
  renderIcons();
};

const renderFriendList = () => {
  dom.friendList.replaceChildren();
  if (!state.friends.length) {
    dom.friendList.append(createElement("div", "cw-list-state", "추가한 친구가 없습니다."));
    return;
  }

  state.friends.forEach((friend) => {
    const row = createElement("button", "cw-friend-row");
    row.type = "button";
    row.append(
      createAvatar(friend.friendUsername, friend.profileImageKey),
      createElement("span", "", friend.friendUsername),
      createElement("span")
    );
    row.addEventListener("click", () => openFriendProfile(friend));
    dom.friendList.append(row);
  });
  renderIcons();
};

const renderCurrentUser = () => {
  if (!state.me) return;
  setAvatar($("#cw-my-avatar"), state.me.username, state.me.profileImageKey);
  $("#cw-my-name").textContent = state.me.username;
  renderIcons();
};

const renderRoomHeader = () => {
  const room = state.rooms.get(state.selectedRoomId);
  const hasRoom = Boolean(room);
  dom.emptyRoom.hidden = hasRoom;
  dom.activeRoom.hidden = !hasRoom;
  if (!room) return;

  renderAvatarStack(dom.headerAvatars, room, true);
  dom.headerName.textContent = displayRoomName(room);
  dom.headerCount.textContent = room.roomType === "GROUP" ? `${room.memberCount}명` : "";
  $("#cw-display-name-setting").textContent = displayRoomName(room);
  $("#cw-base-name-value").textContent = room.baseRoomName || "설정되지 않음";
  $("#cw-custom-name-value").textContent = room.customRoomName || "설정되지 않음";
  const canEditBase = room.roomType === "GROUP" && room.myRole === "OWNER";
  $("#cw-edit-base-name").hidden = !canEditBase;
};

const unreadCountForMessage = (message) => {
  let count = 0;
  state.readStates.forEach((unreadStartMessageId, userId) => {
    if (message.senderId != null && userId === message.senderId) return;
    if (message.messageId >= unreadStartMessageId) count += 1;
  });
  return count;
};

const renderMessages = ({ preserveScroll = false } = {}) => {
  const previousHeight = dom.messages.scrollHeight;
  const previousTop = dom.messages.scrollTop;
  dom.messages.replaceChildren();

  const olderButton = createElement("button", "btn cw-load-older", "이전 메시지");
  olderButton.type = "button";
  olderButton.id = "cw-load-older";
  olderButton.hidden = !state.hasOlderMessages;
  olderButton.disabled = state.loadingOlderMessages;
  olderButton.addEventListener("click", loadOlderMessages);
  dom.messages.append(olderButton);

  if (!state.messages.length) {
    dom.messages.append(createElement("div", "cw-list-state", "아직 메시지가 없습니다."));
    return;
  }

  state.messages.forEach((message) => {
    if (message.chatMessageType === "JOIN_TEXT" || message.chatMessageType === "LEAVE_TEXT") {
      const system = createElement("div", "cw-system-message", message.content);
      system.append(createElement("span", "cw-system-time", formatMessageTime(message.createdAt)));
      dom.messages.append(system);
      return;
    }

    const mine = message.senderId != null && message.senderId === state.me?.userId;
    const row = createElement("div", `cw-message-row${mine ? " mine" : ""}`);
    if (!mine) {
      row.append(createAvatar(message.senderName, message.senderProfileImageKey));
    }

    const body = createElement("div", "cw-message-body");
    if (!mine) {
      body.append(createElement("span", "cw-message-sender", message.senderName || "알 수 없는 사용자"));
    }
    body.append(createElement("div", "cw-message", message.content));

    const metadata = createElement("div", "cw-message-meta");
    const unreadCount = unreadCountForMessage(message);
    if (unreadCount > 0) metadata.append(createElement("span", "cw-message-unread", String(unreadCount)));
    metadata.append(createElement("span", "cw-message-time", formatMessageTime(message.createdAt)));
    body.append(metadata);
    row.append(body);
    dom.messages.append(row);
  });

  if (preserveScroll) {
    dom.messages.scrollTop = dom.messages.scrollHeight - previousHeight + previousTop;
  } else {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }
  renderIcons();
};

const showMessage = (message, action = null) => {
  messageDialogAction = action;
  dom.messageDialogText.textContent = message;
  dom.messageDialog.hidden = false;
  dom.messageDialogConfirm.focus();
};

const closeMessage = () => {
  dom.messageDialog.hidden = true;
  const action = messageDialogAction;
  messageDialogAction = null;
  action?.();
};

const closeDialogs = () => {
  $$(".cw-dialog-backdrop").forEach((dialog) => {
    if (dialog !== dom.messageDialog) dialog.hidden = true;
  });
  dom.namePopover.hidden = true;
};

const setSubmitting = (form, submitting) => {
  [...form.elements].forEach((element) => { element.disabled = submitting; });
};

const handleError = (error) => {
  if (error?.name === "AbortError") return;
  showMessage(error?.message || String(error), error?.status === 401 ? redirectToLogin : null);
};

const redirectToLogin = () => {
  clearAccessToken();
  window.location.replace("index.html");
};

const loadFriends = async () => {
  state.friends = (await api.getFriends()).map((friend) => ({
    friendId: toNumber(friend.friendId),
    friendUsername: friend.friendUsername,
    profileImageKey: friend.profileImageKey ?? null
  }));
  renderFriendList();
};

const syncRoomList = async () => {
  if (state.roomListSyncPromise) return state.roomListSyncPromise;

  state.roomListSyncPromise = (async () => {
    state.roomListSyncing = true;
    state.pendingRoomListEvents = [];

    try {
      const response = await api.getChatRooms();
      state.rooms = new Map(response.map((room) => {
        const normalized = normalizeRoom(room);
        return [normalized.roomId, normalized];
      }));

      const snapshotRooms = new Map(
        [...state.rooms.values()].map((room) => [room.roomId, { ...room }])
      );
      const queuedEvents = state.pendingRoomListEvents;
      state.pendingRoomListEvents = [];
      queuedEvents.forEach((event) => applyRoomListEvent(event, snapshotRooms.get(toNumber(event.roomId))));
      if (state.selectedRoomId != null && !state.rooms.has(state.selectedRoomId)) {
        removeRoom(state.selectedRoomId);
      }
      renderRoomList();
      renderRoomHeader();
    } catch (error) {
      const queuedEvents = state.pendingRoomListEvents;
      state.pendingRoomListEvents = [];
      queuedEvents.forEach((event) => applyRoomListEvent(event));
      throw error;
    } finally {
      state.roomListSyncing = false;
      state.roomListSyncPromise = null;
    }
  })();

  return state.roomListSyncPromise;
};

const patchIfPresent = (target, source, fields) => {
  fields.forEach((field) => {
    if (source[field] != null) target[field] = source[field];
  });
};

const applyMessageToRoom = (room, event, snapshotMessageId = null) => {
  const eventMessageId = toNumber(event.messageId);
  if (eventMessageId == null) return;
  if (snapshotMessageId != null && eventMessageId <= snapshotMessageId) return;

  if (room.messageId == null || eventMessageId > room.messageId) {
    room.messageId = eventMessageId;
    if (event.lastMessagePreview != null) room.lastMessagePreview = event.lastMessagePreview;
    if (event.lastActivityAt != null) room.lastActivityAt = event.lastActivityAt;
  }

  if (room.unreadStartMessageId != null && eventMessageId >= room.unreadStartMessageId) {
    room.unreadCount += 1;
  }
};

const eventWasIncludedInSnapshot = (event, snapshotRoom) => {
  if (!snapshotRoom) return false;
  const eventMessageId = toNumber(event.messageId);
  if (eventMessageId == null) return event.eventType === "ROOM_ADDED";
  return snapshotRoom.messageId != null && eventMessageId <= snapshotRoom.messageId;
};

const removeRoom = (roomId) => {
  state.rooms.delete(roomId);
  if (state.selectedRoomId === roomId) {
    clearTimeout(state.membershipRefreshTimer);
    state.membershipRefreshVersion += 1;
    state.selectedRoomId = null;
    state.messages = [];
    state.readStates.clear();
    state.members = [];
    state.detailLoadVersion += 1;
    state.hasOlderMessages = false;
    state.loadingOlderMessages = false;
    socket.unsubscribeRoom();
    dom.detailPanel.hidden = true;
    dom.namePopover.hidden = true;
    renderRoomHeader();
  }
};

const applyRoomListEvent = (event, snapshotRoom = null) => {
  const roomId = toNumber(event.roomId);
  if (roomId == null) return;
  const includedInSnapshot = eventWasIncludedInSnapshot(event, snapshotRoom);

  if (event.eventType === "ROOM_ADDED") {
    if (!includedInSnapshot) state.rooms.set(roomId, normalizeRoom(event));
  } else if (event.eventType === "ROOM_REMOVED") {
    removeRoom(roomId);
  } else {
    const room = state.rooms.get(roomId);
    if (!room) return;

    if (event.eventType === "ROOM_CHANGED") {
      if (!includedInSnapshot) {
        patchIfPresent(room, event, ["roomType", "baseRoomName", "customRoomName", "myRole"]);
        if (event.memberCount != null) room.memberCount = toNumber(event.memberCount);
        if (event.previewUsers != null) room.previewUsers = normalizePreviewUsers(event.previewUsers);
      }
      applyMessageToRoom(room, event, snapshotRoom?.messageId ?? null);
      if (!includedInSnapshot && roomId === state.selectedRoomId) scheduleSelectedMembershipRefresh();
    } else if (event.eventType === "ROOM_NAME_CHANGED") {
      patchIfPresent(room, event, ["baseRoomName", "customRoomName"]);
    } else if (event.eventType === "MESSAGE_SENT") {
      applyMessageToRoom(room, event, snapshotRoom?.messageId ?? null);
    } else if (event.eventType === "MESSAGE_READ") {
      const nextBoundary = toNumber(event.unreadStartMessageId);
      if (nextBoundary != null && (room.unreadStartMessageId == null || nextBoundary > room.unreadStartMessageId)) {
        room.unreadStartMessageId = nextBoundary;
        room.unreadCount = toNumber(event.unreadCount) ?? room.unreadCount;
      }
    }
  }

  renderRoomList();
  renderRoomHeader();
};

const handleRoomListEvent = (event) => {
  if (state.roomListSyncing) {
    state.pendingRoomListEvents.push(event);
    return;
  }
  applyRoomListEvent(event);
};

const applyRoomEvent = (event, snapshotMessageId = null) => {
  if (toNumber(event.roomId) !== state.selectedRoomId) return;

  if (event.chatEventType === "MESSAGE_SENT") {
    const message = normalizeMessage(event);
    if (snapshotMessageId != null && message.messageId <= snapshotMessageId) return;
    if (!state.messages.some((candidate) => candidate.messageId === message.messageId)) {
      state.messages.push(message);
      state.messages.sort((left, right) => left.messageId - right.messageId);
      renderMessages();
      scheduleRead();

      const room = state.rooms.get(state.selectedRoomId);
      if (room && state.readStates.size !== room.memberCount) {
        scheduleSelectedMembershipRefresh();
      }
    }
  } else if (event.chatEventType === "MESSAGE_READ") {
    const readerUserId = toNumber(event.readerUserId);
    const nextBoundary = toNumber(event.unreadStartMessageId);
    const currentBoundary = state.readStates.get(readerUserId);
    if (readerUserId != null && nextBoundary != null && (currentBoundary == null || nextBoundary > currentBoundary)) {
      state.readStates.set(readerUserId, nextBoundary);
      renderMessages({ preserveScroll: true });
    }
  }
};

const handleRoomEvent = (event) => {
  if (state.roomSyncing && toNumber(event.roomId) === state.selectedRoomId) {
    state.pendingRoomEvents.push(event);
    return;
  }
  applyRoomEvent(event);
};

const loadRoomSnapshot = async (roomId, { preservePendingEvents = false } = {}) => {
  state.roomAbortController?.abort();
  state.roomAbortController = new AbortController();
  const version = ++state.roomLoadVersion;
  state.roomSyncing = true;
  if (!preservePendingEvents) state.pendingRoomEvents = [];
  dom.messages.replaceChildren(createElement("div", "cw-list-state", "메시지를 불러오는 중입니다."));

  try {
    const [messages, readStatuses] = await Promise.all([
      api.getMessages(roomId, null, state.roomAbortController.signal),
      api.getReadStatuses(roomId, state.roomAbortController.signal)
    ]);
    if (state.selectedRoomId !== roomId || version !== state.roomLoadVersion) return;

    state.messages = messages.map(normalizeMessage).sort((left, right) => left.messageId - right.messageId);
    state.hasOlderMessages = messages.length === 100;
    state.loadingOlderMessages = false;
    state.readStates = new Map(readStatuses.map((status) => [
      toNumber(status.userId),
      toNumber(status.unreadStartMessageId)
    ]));

    const snapshotMessageId = state.messages.at(-1)?.messageId ?? null;
    const queuedEvents = state.pendingRoomEvents;
    state.pendingRoomEvents = [];
    queuedEvents.forEach((event) => applyRoomEvent(event, snapshotMessageId));
    renderMessages();
    scheduleRead();
  } finally {
    if (version === state.roomLoadVersion) state.roomSyncing = false;
  }
};

const openRoom = async (roomId) => {
  if (!state.rooms.has(roomId)) return;
  closeDialogs();
  state.selectedRoomId = roomId;
  clearTimeout(state.membershipRefreshTimer);
  state.membershipRefreshVersion += 1;
  state.detailLoadVersion += 1;
  state.messages = [];
  state.readStates.clear();
  state.members = [];
  dom.detailPanel.hidden = true;
  dom.namePopover.hidden = true;
  state.hasOlderMessages = false;
  state.loadingOlderMessages = false;
  socket.subscribeRoom(roomId);
  renderRoomList();
  renderRoomHeader();
  await loadRoomSnapshot(roomId).catch(handleError);
};

const loadOlderMessages = async () => {
  if (!state.selectedRoomId || !state.messages.length || !state.hasOlderMessages || state.loadingOlderMessages) return;
  const roomId = state.selectedRoomId;
  const offset = state.messages[0].messageId;
  state.loadingOlderMessages = true;
  const button = $("#cw-load-older");
  if (button) button.disabled = true;

  try {
    const response = await api.getMessages(roomId, offset);
    if (state.selectedRoomId !== roomId) return;

    state.hasOlderMessages = response.length === 100;
    const older = response.map(normalizeMessage);
    const existingIds = new Set(state.messages.map((message) => message.messageId));
    state.messages = [...older.filter((message) => !existingIds.has(message.messageId)), ...state.messages]
      .sort((left, right) => left.messageId - right.messageId);
    state.loadingOlderMessages = false;
    renderMessages({ preserveScroll: true });
  } catch (error) {
    handleError(error);
  } finally {
    if (state.selectedRoomId === roomId && state.loadingOlderMessages) {
      state.loadingOlderMessages = false;
      const currentButton = $("#cw-load-older");
      if (currentButton) currentButton.disabled = false;
    }
  }
};

const scheduleRead = () => {
  clearTimeout(state.readTimer);
  const roomId = state.selectedRoomId;
  const latestMessageId = state.messages.at(-1)?.messageId;
  if (!roomId || latestMessageId == null) return;

  state.readTimer = setTimeout(() => {
    if (state.selectedRoomId !== roomId) return;
    try {
      socket.sendRead(roomId, latestMessageId);
    } catch (error) {
      handleError(error);
    }
  }, 250);
};

const refreshSelectedMembershipState = async () => {
  const roomId = state.selectedRoomId;
  if (!roomId) return;
  const version = ++state.membershipRefreshVersion;

  const shouldRefreshMembers = !dom.detailPanel.hidden;
  const [statuses, members] = await Promise.all([
    api.getReadStatuses(roomId),
    shouldRefreshMembers ? api.getRoomMembers(roomId) : Promise.resolve(null)
  ]);
  if (state.selectedRoomId !== roomId || state.membershipRefreshVersion !== version) return;

  state.readStates = new Map(statuses.map((status) => [toNumber(status.userId), toNumber(status.unreadStartMessageId)]));
  if (members) {
    state.members = members;
    renderMembers();
  }
  renderMessages({ preserveScroll: true });
};

const scheduleSelectedMembershipRefresh = () => {
  clearTimeout(state.membershipRefreshTimer);
  const roomId = state.selectedRoomId;
  if (!roomId) return;

  state.membershipRefreshTimer = setTimeout(() => {
    if (state.selectedRoomId !== roomId) return;
    refreshSelectedMembershipState().catch(handleError);
  }, 50);
};

const renderSelectableFriends = (container, friends, checkboxClass) => {
  container.replaceChildren();
  if (!friends.length) {
    container.append(createElement("div", "cw-list-state", "선택할 수 있는 친구가 없습니다."));
    return;
  }

  friends.forEach((friend) => {
    const label = createElement("label", "cw-invite-row");
    const checkbox = createElement("input", `form-check-input ${checkboxClass}`);
    checkbox.type = "checkbox";
    checkbox.value = String(friend.userId ?? friend.friendId);
    label.append(
      createAvatar(friend.username ?? friend.friendUsername, friend.profileImageKey),
      createElement("span", "", friend.username ?? friend.friendUsername),
      checkbox
    );
    container.append(label);
  });
  renderIcons();
};

const openFriendProfile = (friend) => {
  closeDialogs();
  state.selectedFriend = friend;
  setAvatar($("#cw-friend-profile-avatar"), friend.friendUsername, friend.profileImageKey);
  $("#cw-friend-profile-name").textContent = friend.friendUsername;
  $("#cw-friend-profile-dialog").hidden = false;
  renderIcons();
};

const openNewChatDialog = () => {
  closeDialogs();
  renderSelectableFriends(
    $("#cw-new-chat-friends"),
    state.friends,
    "cw-new-chat-check"
  );
  $("#cw-group-name").value = "";
  $("#cw-group-name-field").hidden = true;
  $("#cw-new-chat-submit").disabled = true;
  $("#cw-new-chat-dialog").hidden = false;
};

const openInviteDialog = async () => {
  if (!state.selectedRoomId) return;
  closeDialogs();
  $("#cw-invite-dialog").hidden = false;
  $("#cw-invitable-friends").replaceChildren(createElement("div", "cw-list-state", "초대 가능한 친구를 불러오는 중입니다."));

  try {
    const friends = await api.getInvitableFriends(state.selectedRoomId);
    renderSelectableFriends($("#cw-invitable-friends"), friends, "cw-invite-check");
    $("#cw-invite-submit").disabled = true;
  } catch (error) {
    closeDialogs();
    handleError(error);
  }
};

const renderMembers = () => {
  dom.memberList.replaceChildren();
  state.members.forEach((member) => {
    const row = createElement("div", "cw-member-row");
    const action = member.canAddFriend
      ? createElement("button", "btn btn-small", "친구 추가")
      : createElement("span", "text-small text-muted", member.chatRoomUserRole);
    if (member.canAddFriend) {
      action.type = "button";
      action.addEventListener("click", async () => {
        try {
          await api.addFriend(member.username);
          await loadFriends();
          member.canAddFriend = false;
          renderMembers();
        } catch (error) {
          handleError(error);
        }
      });
    }
    row.append(createAvatar(member.username, member.profileImageKey), createElement("span", "", member.username), action);
    dom.memberList.append(row);
  });
  dom.detailTitle.textContent = `참여자 ${state.members.length}명`;
  renderIcons();
};

const openDetails = async () => {
  const roomId = state.selectedRoomId;
  if (!roomId) return;
  const version = ++state.detailLoadVersion;
  dom.namePopover.hidden = true;
  dom.detailPanel.hidden = false;
  dom.memberList.replaceChildren(createElement("div", "cw-list-state", "참여자를 불러오는 중입니다."));
  try {
    const members = await api.getRoomMembers(roomId);
    if (state.selectedRoomId !== roomId || state.detailLoadVersion !== version || dom.detailPanel.hidden) return;
    state.members = members;
    renderMembers();
  } catch (error) {
    if (state.selectedRoomId !== roomId || state.detailLoadVersion !== version) return;
    dom.detailPanel.hidden = true;
    handleError(error);
  }
};

const openEditDialog = (target) => {
  const room = target === "me" ? null : state.rooms.get(state.selectedRoomId);
  if (target !== "me" && !room) return;
  state.editTarget = target;
  $("#cw-edit-dialog-title").textContent = target === "base" ? "기본 이름 수정" : target === "custom" ? "내가 보는 이름 수정" : "내 이름 수정";
  $("#cw-edit-input-label").textContent = target === "base" ? "기본 이름" : target === "custom" ? "내가 보는 이름" : "이름";
  $("#cw-edit-input").value = target === "base" ? room.baseRoomName || "" : target === "custom" ? room.customRoomName || "" : state.me.username;
  $("#cw-edit-dialog").hidden = false;
  $("#cw-edit-input").focus();
};

const openLeaveDialog = () => {
  const room = state.rooms.get(state.selectedRoomId);
  if (!room) return;
  dom.detailPanel.hidden = true;
  const candidates = state.members.filter((member) => member.userId !== state.me.userId);
  const needsNextOwner = room.myRole === "OWNER" && candidates.length > 0;
  $("#cw-next-owner-field").hidden = !needsNextOwner;
  $("#cw-leave-copy").textContent = needsNextOwner
    ? "방장을 양도한 뒤 채팅방을 나갑니다."
    : "채팅방을 나가시겠습니까?";
  const select = $("#cw-next-owner");
  select.replaceChildren();
  candidates.forEach((member) => {
    const option = createElement("option", "", member.username);
    option.value = member.userId;
    select.append(option);
  });
  $("#cw-leave-dialog").hidden = false;
};

const selectSidebarTab = (tab) => {
  Object.entries(sidebarViews).forEach(([key, view]) => { view.hidden = key !== tab; });
  Object.entries(sidebarTabs).forEach(([key, button]) => {
    const selected = key === tab;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  dom.sidebarTitle.textContent = tab === "friends" ? "친구" : tab === "settings" ? "설정" : "채팅";
  dom.newChatButton.hidden = tab !== "chats";
  dom.addFriendButton.hidden = tab !== "friends";
};

const handleSocketConnected = async () => {
  const firstConnection = !state.hasConnected;
  const reconnectingRoomId = firstConnection ? null : state.selectedRoomId;
  if (reconnectingRoomId != null) {
    state.roomSyncing = true;
    state.pendingRoomEvents = [];
  }

  try {
    await Promise.all([
      syncRoomList(),
      firstConnection ? loadFriends() : Promise.resolve()
    ]);
    if (reconnectingRoomId != null && state.selectedRoomId === reconnectingRoomId && state.rooms.has(reconnectingRoomId)) {
      await loadRoomSnapshot(reconnectingRoomId, { preservePendingEvents: true });
      if (!dom.detailPanel.hidden) await refreshSelectedMembershipState();
    } else if (reconnectingRoomId != null) {
      state.roomSyncing = false;
      state.pendingRoomEvents = [];
    }
    state.hasConnected = true;
  } catch (error) {
    if (reconnectingRoomId != null) {
      state.roomSyncing = false;
      state.pendingRoomEvents = [];
    }
    handleError(error);
  }
};

const socket = new ChatSocket({
  onConnected: handleSocketConnected,
  onListEvent: handleRoomListEvent,
  onRoomEvent: handleRoomEvent,
  onError: (message, options = {}) => {
    if (!options.transient) showMessage(message);
  },
  onAuthFailure: () => redirectToLogin()
});

const bindEvents = () => {
  Object.entries(sidebarTabs).forEach(([tab, button]) => button.addEventListener("click", () => selectSidebarTab(tab)));
  dom.newChatButton.addEventListener("click", openNewChatDialog);
  dom.addFriendButton.addEventListener("click", () => {
    closeDialogs();
    $("#cw-friend-add-form").reset();
    $("#cw-friend-add-dialog").hidden = false;
    $("#cw-friend-username").focus();
  });
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", closeDialogs));
  $$(".cw-dialog-backdrop").forEach((backdrop) => {
    if (backdrop === dom.messageDialog) return;
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialogs();
    });
  });
  dom.messageDialogConfirm.addEventListener("click", closeMessage);

  $("#cw-friend-add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const username = $("#cw-friend-username").value.trim();
    if (!username) return;
    setSubmitting(form, true);
    try {
      await api.addFriend(username);
      await loadFriends();
      closeDialogs();
      showMessage("친구를 추가했습니다.");
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(form, false);
    }
  });

  $("#cw-new-chat-friends").addEventListener("change", () => {
    const count = $$(".cw-new-chat-check:checked").length;
    $("#cw-new-chat-submit").disabled = count === 0;
    $("#cw-group-name-field").hidden = count < 2;
  });

  $("#cw-new-chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const friendIds = $$(".cw-new-chat-check:checked").map((checkbox) => Number(checkbox.value));
    if (!friendIds.length) return;
    setSubmitting(form, true);
    try {
      const result = friendIds.length === 1
        ? await api.createDirectRoom(friendIds[0])
        : await api.createGroupRoom(friendIds, $("#cw-group-name").value.trim());
      closeDialogs();
      await syncRoomList();
      await openRoom(toNumber(result.chatRoomId));
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(form, false);
    }
  });

  $("#cw-friend-profile-chat").addEventListener("click", async () => {
    if (!state.selectedFriend) return;
    try {
      const result = await api.createDirectRoom(state.selectedFriend.friendId);
      closeDialogs();
      selectSidebarTab("chats");
      await syncRoomList();
      await openRoom(toNumber(result.chatRoomId));
    } catch (error) {
      handleError(error);
    }
  });

  $("#cw-invite-button").addEventListener("click", openInviteDialog);
  $("#cw-invitable-friends").addEventListener("change", () => {
    $("#cw-invite-submit").disabled = !$(".cw-invite-check:checked");
  });
  $("#cw-invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const room = state.rooms.get(state.selectedRoomId);
    const friendIds = $$(".cw-invite-check:checked").map((checkbox) => Number(checkbox.value));
    if (!room || !friendIds.length) return;
    setSubmitting(form, true);
    try {
      if (room.roomType === "DIRECT") {
        await api.inviteToDirectRoom(room.roomId, friendIds);
      } else {
        await api.inviteToGroupRoom(room.roomId, friendIds);
      }
      closeDialogs();
      scheduleSelectedMembershipRefresh();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(form, false);
    }
  });

  $("#cw-name-button").addEventListener("click", () => {
    dom.detailPanel.hidden = true;
    dom.namePopover.hidden = !dom.namePopover.hidden;
  });
  $("#cw-name-close").addEventListener("click", () => { dom.namePopover.hidden = true; });
  $("#cw-edit-base-name").addEventListener("click", () => openEditDialog("base"));
  $("#cw-edit-custom-name").addEventListener("click", () => openEditDialog("custom"));
  $("#cw-edit-my-name").addEventListener("click", () => openEditDialog("me"));
  $("#cw-edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = $("#cw-edit-input").value.trim();
    const roomId = state.selectedRoomId;
    if (!value) return;
    setSubmitting(form, true);
    try {
      if (state.editTarget === "base") await api.updateBaseRoomName(roomId, value);
      if (state.editTarget === "custom") await api.updateCustomRoomName(roomId, value);
      if (state.editTarget === "me") {
        await api.updateMe(value);
        state.me.username = value;
        renderCurrentUser();
      }
      closeDialogs();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(form, false);
    }
  });

  $("#cw-detail-button").addEventListener("click", openDetails);
  $("#cw-detail-close").addEventListener("click", () => {
    state.detailLoadVersion += 1;
    dom.detailPanel.hidden = true;
  });
  $("#cw-leave-button").addEventListener("click", openLeaveDialog);
  $("#cw-leave-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const roomId = state.selectedRoomId;
    const nextOwnerField = $("#cw-next-owner-field");
    const nextOwnerId = nextOwnerField.hidden ? null : Number($("#cw-next-owner").value);
    setSubmitting(form, true);
    try {
      await api.leaveRoom(roomId, nextOwnerId);
      closeDialogs();
      removeRoom(roomId);
      renderRoomList();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(form, false);
    }
  });

  dom.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = dom.messageInput.value.trim();
    if (!content || !state.selectedRoomId) return;
    try {
      socket.sendMessage(state.selectedRoomId, content);
      dom.messageInput.value = "";
    } catch (error) {
      handleError(error);
    }
  });

  $("#cw-file-button").addEventListener("click", () => showMessage("파일 전송 API는 아직 준비되지 않았습니다."));
  $("#cw-profile-image-button").addEventListener("click", () => showMessage("프로필 이미지 수정 API는 아직 준비되지 않았습니다."));
  $("#cw-logout-button").addEventListener("click", async () => {
    try {
      await api.logout();
    } catch {
      // 서버 로그아웃에 실패해도 현재 브라우저의 인증 상태는 제거한다.
    } finally {
      await socket.disconnect();
      redirectToLogin();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDialogs();
  });
};

const bootstrap = async () => {
  bindEvents();
  if (window.lucide) window.lucide.createIcons({ attrs: { width: 16, height: 16 } });

  try {
    state.me = await api.getMe();
    state.me.userId = toNumber(state.me.userId);
    renderCurrentUser();
    socket.connect();
  } catch (error) {
    showMessage(error.message || "로그인이 필요합니다.", redirectToLogin);
  }
};

bootstrap();
