import {
  ApiError,
  api,
  clearAccessToken,
  ensureAccessToken,
  getAccessToken,
  getApiBaseUrl,
  invalidateSession,
  refreshAccessToken
} from "./api.js";
import { ChatSocket } from "./socket.js";

const LOGIN_EVENT_KEY = "tggChatLoginEvent";
const CREATED_ROOM_EVENT_TIMEOUT_MS = 5000;
const MESSAGE_SCROLL_MODE = Object.freeze({
  BOTTOM: "BOTTOM",
  KEEP_VIEW: "KEEP_VIEW",
  PREPEND: "PREPEND"
});

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
  selectedProfileUser: null,
  messageMediaViewer: null,
  messageMediaLoadVersion: 0,
  refreshMembersOnProfileClose: false,
  editTarget: null,
  roomListSyncing: false,
  roomListSyncPromise: null,
  pendingRoomListEvents: [],
  userMetadataSyncing: false,
  pendingUserMetadataEvents: [],
  pendingRoomOpens: new Map(),
  roomSyncing: false,
  pendingRoomEvents: [],
  roomLoadVersion: 0,
  roomAbortController: null,
  messageScrollPinned: false,
  messageVisibilityCheckVersion: 0,
  newMessageNotice: null,
  readTimer: null,
  membershipRefreshTimer: null,
  membershipRefreshVersion: 0,
  detailLoadVersion: 0,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  hasConnected: false,
  authenticationFailureHandled: false,
  sessionInvalidated: false
};

const dom = {
  shell: $(".cw-shell"),
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
  newMessageNotice: $("#cw-new-message-notice"),
  newMessageNoticeText: $("#cw-new-message-notice-text"),
  composer: $("#cw-composer"),
  fileButton: $("#cw-file-button"),
  fileInput: $("#cw-file-input"),
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
let messageScrollFrame = null;

const createElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

const toNumber = (value) => value == null ? null : Number(value);

const profileImageUrl = (profileImageKey, variant) =>
  `${getApiBaseUrl()}/profile-images/${encodeURIComponent(profileImageKey)}/${variant}`;

const messageFileUrl = (messageId, fileOrder, storedFileVariant) => {
  const query = new URLSearchParams({ storedFileVariant });
  return `${getApiBaseUrl()}/media/messages/${encodeURIComponent(messageId)}/files/${encodeURIComponent(fileOrder)}?${query}`;
};

const renderIcons = () => {
  if (window.lucide) window.lucide.createIcons({ attrs: { width: 16, height: 16 } });
};

const setAvatar = (avatar, username, profileImageKey) => {
  avatar.replaceChildren();
  avatar.setAttribute("aria-label", `${username || "알 수 없는 사용자"} 프로필 이미지`);

  if (profileImageKey) {
    avatar.dataset.profileImageKey = profileImageKey;
    avatar.classList.remove("cw-avatar-default");
    const image = createElement("img", "cw-avatar-image");
    image.src = profileImageUrl(profileImageKey, "thumbnail");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      setAvatar(avatar, username, null);
      renderIcons();
    }, { once: true });
    avatar.append(image);
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

const createProfileAvatarButton = (user) => {
  const avatar = createElement("button", "cw-avatar cw-avatar-button");
  avatar.type = "button";
  setAvatar(avatar, user.username, user.profileImageKey);
  avatar.addEventListener("click", () => openUserProfile(user));
  return avatar;
};

const displayRoomName = (room) => {
  if (room.customRoomName) return room.customRoomName;
  if (room.baseRoomName) return room.baseRoomName;
  const names = room.previewUsers.map((user) => user.username).filter(Boolean);
  if (names.length) {
    const hiddenUserCount = Math.max(0, room.memberCount - 1 - room.previewUsers.length);
    const visibleName = names.join(", ");
    return hiddenUserCount > 0 ? `${visibleName} 외 ${hiddenUserCount}명` : visibleName;
  }
  return room.roomType === "DIRECT" ? "?" : "";
};

const formatMessageTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(date);
};

const formatActivityTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return formatMessageTime(value);
  }
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(date);
};

const messageDateKey = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const formatMessageDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(date);
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

const normalizeMessageFiles = (files) => Array.isArray(files)
  ? files
      .map((file) => ({
        fileOrder: toNumber(file.fileOrder),
        fileCategory: file.fileCategory ?? "FILE",
        originalFileName: file.originalFileName || "파일",
        fileSize: toNumber(file.fileSize)
      }))
      .filter((file) => Number.isInteger(file.fileOrder) && file.fileOrder >= 0)
      .sort((left, right) => left.fileOrder - right.fileOrder)
  : [];

const normalizeMessage = (message) => ({
  messageId: toNumber(message.messageId),
  chatMessageType: message.chatMessageType ?? "TEXT",
  content: message.content ?? "",
  senderId: toNumber(message.senderId),
  senderName: message.senderName ?? null,
  senderProfileImageKey: message.senderProfileImageKey ?? null,
  createdAt: message.createdAt ?? null,
  chatEventFiles: normalizeMessageFiles(message.chatEventFiles)
});

const renderAvatarStack = (container, room, large = false, opensDetails = false) => {
  container.replaceChildren();
  room.previewUsers.forEach((user) => {
    const extraClass = large ? "cw-avatar-large" : "";
    if (!opensDetails) {
      container.append(createAvatar(user.username, user.profileImageKey, extraClass));
      return;
    }

    const avatar = createElement("button", `cw-avatar cw-avatar-button ${extraClass}`.trim());
    avatar.type = "button";
    setAvatar(avatar, user.username, user.profileImageKey);
    avatar.setAttribute("aria-label", `${user.username || "알 수 없는 사용자"} 참여자 상세정보`);
    avatar.addEventListener("click", openDetails);
    container.append(avatar);
  });

  const hiddenUserCount = Math.max(0, room.memberCount - 1 - room.previewUsers.length);
  if (hiddenUserCount > 0) {
    const overflow = createElement(
      opensDetails ? "button" : "span",
      `cw-avatar cw-avatar-overflow${large ? " cw-avatar-large" : ""}${opensDetails ? " cw-avatar-button" : ""}`,
      `외${hiddenUserCount}`
    );
    if (opensDetails) {
      overflow.type = "button";
      overflow.setAttribute("aria-label", `외 ${hiddenUserCount}명 참여자 상세정보`);
      overflow.addEventListener("click", openDetails);
    }
    container.append(overflow);
  }

  if (!container.childElementCount) {
    const extraClass = large ? "cw-avatar-large" : "";
    if (opensDetails) {
      const avatar = createElement("button", `cw-avatar cw-avatar-button ${extraClass}`.trim());
      avatar.type = "button";
      setAvatar(avatar, "?", null);
      avatar.setAttribute("aria-label", "참여자 상세정보");
      avatar.addEventListener("click", openDetails);
      container.append(avatar);
    } else {
      container.append(createAvatar("?", null, extraClass));
    }
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
    row.addEventListener("click", () => openUserProfile(friend));
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
  dom.shell.classList.toggle("is-room-open", hasRoom);
  dom.emptyRoom.hidden = hasRoom;
  dom.activeRoom.hidden = !hasRoom;
  if (!room) return;

  renderAvatarStack(dom.headerAvatars, room, true, true);
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

const maintainPinnedMessageScroll = () => {
  if (!state.messageScrollPinned) return;
  dom.messages.scrollTop = dom.messages.scrollHeight;
  requestAnimationFrame(() => {
    if (state.messageScrollPinned) dom.messages.scrollTop = dom.messages.scrollHeight;
  });
};

const isMessageListAtBottom = () =>
  dom.messages.scrollHeight - dom.messages.clientHeight - dom.messages.scrollTop <= 2;

const currentMessageScrollMode = () =>
  state.messageScrollPinned || isMessageListAtBottom()
    ? MESSAGE_SCROLL_MODE.BOTTOM
    : MESSAGE_SCROLL_MODE.KEEP_VIEW;

const findMessageElement = (messageId) =>
  messageId == null
    ? null
    : dom.messages.querySelector(`[data-message-id="${messageId}"]`);

const isMessageVisible = (messageId) => {
  const messageElement = findMessageElement(messageId);
  if (!messageElement) return false;

  const viewportRect = dom.messages.getBoundingClientRect();
  const messageRect = messageElement.getBoundingClientRect();
  return messageRect.bottom > viewportRect.top && messageRect.top < viewportRect.bottom;
};

const captureMessageScrollAnchor = () => {
  const viewportRect = dom.messages.getBoundingClientRect();
  const messageElement = [...dom.messages.querySelectorAll("[data-message-id]")]
    .find((candidate) => {
      const candidateRect = candidate.getBoundingClientRect();
      return candidateRect.bottom > viewportRect.top && candidateRect.top < viewportRect.bottom;
    });

  if (!messageElement) return null;
  return {
    messageId: Number(messageElement.dataset.messageId),
    offsetTop: messageElement.getBoundingClientRect().top - viewportRect.top
  };
};

const restoreMessageScrollAnchor = (anchor, fallbackTop) => {
  dom.messages.scrollTop = fallbackTop;
  if (!anchor) return;

  const messageElement = findMessageElement(anchor.messageId);
  if (!messageElement) return;

  const viewportTop = dom.messages.getBoundingClientRect().top;
  const nextOffsetTop = messageElement.getBoundingClientRect().top - viewportTop;
  dom.messages.scrollTop += nextOffsetTop - anchor.offsetTop;
};

const hideNewMessageNotice = () => {
  state.newMessageNotice = null;
  dom.newMessageNotice.hidden = true;
  dom.newMessageNoticeText.textContent = "";
};

const cancelNewMessageNotice = () => {
  state.messageVisibilityCheckVersion += 1;
  hideNewMessageNotice();
};

const showNewMessageNotice = (message) => {
  const content = String(message.content ?? "").trim()
    || (message.chatMessageType === "FILE" ? `파일 ${message.chatEventFiles.length}개` : "새 메시지가 도착했습니다.");
  state.newMessageNotice = {
    roomId: state.selectedRoomId,
    messageId: message.messageId
  };
  dom.newMessageNoticeText.textContent = content;
  dom.newMessageNotice.hidden = false;
};

const scheduleNewMessageVisibilityCheck = (message) => {
  const roomId = state.selectedRoomId;
  const version = ++state.messageVisibilityCheckVersion;

  requestAnimationFrame(() => {
    if (
      version !== state.messageVisibilityCheckVersion
      || roomId !== state.selectedRoomId
    ) return;

    if (state.newMessageNotice && isMessageVisible(state.newMessageNotice.messageId)) {
      hideNewMessageNotice();
    }
    if (isMessageVisible(message.messageId)) return;
    showNewMessageNotice(message);
  });
};

const formatFileSize = (fileSize) => {
  if (!Number.isFinite(fileSize) || fileSize < 0) return "크기 정보 없음";
  if (fileSize === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(fileSize) / Math.log(1024)), units.length - 1);
  const value = fileSize / (1024 ** unitIndex);
  const fractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
};

const mediaRetryUrl = (url) => `${url}&_retry=${Date.now()}`;

const replaceMediaWithFallback = (media, iconName, label) => {
  if (!media.isConnected) return;
  const fallback = createElement("span", "cw-media-thumbnail-fallback");
  const icon = createElement("i");
  icon.setAttribute("data-lucide", iconName);
  icon.setAttribute("aria-hidden", "true");
  fallback.append(icon, createElement("span", "", label));
  media.replaceWith(fallback);
  renderIcons();
};

const loadRetryableImage = (image, url, onFailure) => {
  let retried = false;

  const handleMediaError = async () => {
    if (!image.isConnected) {
      image.removeEventListener("error", handleMediaError);
      return;
    }

    if (!retried) {
      retried = true;
      try {
        await ensureAccessToken();
        if (!image.isConnected) return;
        image.src = mediaRetryUrl(url);
        return;
      } catch (error) {
        image.removeEventListener("error", handleMediaError);
        const mediaViewerOpen = !$("#cw-message-media-dialog").hidden;
        if (mediaViewerOpen) closeMessageMediaViewer();
        handleError(error);
        if (!mediaViewerOpen) onFailure();
        return;
      }
    }

    image.removeEventListener("error", handleMediaError);
    onFailure();
  };

  image.addEventListener("error", handleMediaError);
  image.src = url;
};

const loadRetryableVideo = (video, url, onFailure) => {
  let retried = false;

  const handleMediaError = async () => {
    if (!video.isConnected) {
      video.removeEventListener("error", handleMediaError);
      return;
    }

    if (!retried) {
      retried = true;
      try {
        await ensureAccessToken();
        if (!video.isConnected) return;
        video.src = mediaRetryUrl(url);
        video.load();
        return;
      } catch (error) {
        video.removeEventListener("error", handleMediaError);
        const mediaViewerOpen = !$("#cw-message-media-dialog").hidden;
        if (mediaViewerOpen) closeMessageMediaViewer();
        handleError(error);
        if (!mediaViewerOpen) onFailure();
        return;
      }
    }

    video.removeEventListener("error", handleMediaError);
    onFailure();
  };

  video.addEventListener("error", handleMediaError);
  video.src = url;
  video.load();
};

const showMessageMediaError = (message) => {
  const stage = $("#cw-message-media-stage");
  stage.replaceChildren();

  const error = createElement("div", "cw-message-media-error");
  const icon = createElement("i");
  icon.setAttribute("data-lucide", "circle-alert");
  icon.setAttribute("aria-hidden", "true");
  const retryButton = createElement("button", "btn", "다시 시도");
  retryButton.type = "button";
  retryButton.addEventListener("click", renderMessageMediaViewer);
  error.append(icon, createElement("span", "", message), retryButton);
  stage.append(error);
  renderIcons();
};

const closeMessageMediaViewer = () => {
  const dialog = $("#cw-message-media-dialog");
  const trigger = state.messageMediaViewer?.triggerElement;

  state.messageMediaViewer = null;
  state.messageMediaLoadVersion += 1;
  dialog.hidden = true;

  $("#cw-message-media-stage").querySelectorAll("video").forEach((video) => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  $("#cw-message-media-stage").replaceChildren();

  if (trigger?.isConnected) trigger.focus();
};

const renderMessageMediaViewer = async () => {
  const viewer = state.messageMediaViewer;
  if (!viewer) return;

  const version = ++state.messageMediaLoadVersion;
  const file = viewer.files[viewer.activeIndex];
  const stage = $("#cw-message-media-stage");
  const previousButton = $("#cw-message-media-previous");
  const nextButton = $("#cw-message-media-next");
  const hasImageNavigation = viewer.mediaType === "IMAGE" && viewer.files.length > 1;

  const title = $("#cw-message-media-title");
  title.textContent = file.originalFileName;
  title.title = file.originalFileName;
  previousButton.hidden = !hasImageNavigation;
  nextButton.hidden = !hasImageNavigation;
  previousButton.disabled = viewer.activeIndex === 0;
  nextButton.disabled = viewer.activeIndex === viewer.files.length - 1;
  stage.replaceChildren(createElement("div", "cw-message-media-loading", "미디어를 불러오는 중입니다."));

  try {
    await ensureAccessToken();
  } catch (error) {
    if (version !== state.messageMediaLoadVersion) return;
    closeMessageMediaViewer();
    handleError(error);
    return;
  }

  if (version !== state.messageMediaLoadVersion || state.messageMediaViewer !== viewer) return;

  const originalUrl = messageFileUrl(viewer.messageId, file.fileOrder, "ORIGINAL");
  stage.replaceChildren();

  if (viewer.mediaType === "IMAGE") {
    const image = createElement("img", "cw-message-media-image");
    image.alt = file.originalFileName;
    stage.append(image);
    loadRetryableImage(image, originalUrl, () => showMessageMediaError("이미지를 불러오지 못했습니다."));
    return;
  }

  const video = createElement("video", "cw-message-media-video");
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.setAttribute("aria-label", file.originalFileName);
  stage.append(video);
  loadRetryableVideo(video, originalUrl, () => showMessageMediaError("이 동영상을 재생할 수 없습니다."));
};

const openImageMessageViewer = (message, imageFiles, activeIndex, triggerElement) => {
  state.messageMediaViewer = {
    mediaType: "IMAGE",
    messageId: message.messageId,
    files: imageFiles,
    activeIndex,
    triggerElement
  };
  $("#cw-message-media-dialog").hidden = false;
  renderMessageMediaViewer();
  $("#cw-message-media-close").focus();
};

const openVideoMessageViewer = (message, file, triggerElement) => {
  state.messageMediaViewer = {
    mediaType: "VIDEO",
    messageId: message.messageId,
    files: [file],
    activeIndex: 0,
    triggerElement
  };
  $("#cw-message-media-dialog").hidden = false;
  renderMessageMediaViewer();
  $("#cw-message-media-close").focus();
};

const moveMessageMediaViewer = (offset) => {
  const viewer = state.messageMediaViewer;
  if (!viewer || viewer.mediaType !== "IMAGE") return;

  const nextIndex = viewer.activeIndex + offset;
  if (nextIndex < 0 || nextIndex >= viewer.files.length) return;
  viewer.activeIndex = nextIndex;
  renderMessageMediaViewer();
};

const createImageGallery = (message, imageFiles) => {
  const gallery = createElement("div", "cw-message-image-gallery");
  const layout = imageFiles.length <= 5 ? String(imageFiles.length) : "many";
  gallery.dataset.layout = layout;

  imageFiles.forEach((file, index) => {
    const button = createElement("button", "cw-message-image-button");
    button.type = "button";
    button.setAttribute("aria-label", `${file.originalFileName} 원본 보기`);

    const image = createElement("img", "cw-message-image-thumbnail");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    button.append(image);
    button.addEventListener("click", () => openImageMessageViewer(message, imageFiles, index, button));
    gallery.append(button);

    loadRetryableImage(
      image,
      messageFileUrl(message.messageId, file.fileOrder, "THUMBNAIL"),
      () => replaceMediaWithFallback(image, "image-off", "이미지 없음")
    );
  });

  return gallery;
};

const createVideoAttachment = (message, file) => {
  const button = createElement("button", "cw-message-video-button");
  button.type = "button";
  button.setAttribute("aria-label", `${file.originalFileName} 동영상 재생`);

  const image = createElement("img", "cw-message-video-thumbnail");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";

  const play = createElement("span", "cw-message-video-play");
  const playIcon = createElement("i");
  playIcon.setAttribute("data-lucide", "play");
  playIcon.setAttribute("aria-hidden", "true");
  play.append(playIcon);

  button.append(image, play);
  button.addEventListener("click", () => openVideoMessageViewer(message, file, button));
  loadRetryableImage(
    image,
    messageFileUrl(message.messageId, file.fileOrder, "THUMBNAIL"),
    () => replaceMediaWithFallback(image, "video-off", "미리보기 없음")
  );
  return button;
};

const createFileAttachment = (message, file) => {
  const item = createElement("div", "cw-message-file-item");
  const fileIcon = createElement("span", "cw-message-file-icon");
  const icon = createElement("i");
  icon.setAttribute("data-lucide", "file");
  icon.setAttribute("aria-hidden", "true");
  fileIcon.append(icon);

  const copy = createElement("span", "cw-message-file-copy");
  const name = createElement("span", "cw-message-file-name", file.originalFileName);
  name.title = file.originalFileName;
  copy.append(name, createElement("span", "cw-message-file-size", formatFileSize(file.fileSize)));

  const downloadButton = createElement("button", "btn btn-ghost cw-icon-button cw-message-file-download");
  const downloadIcon = createElement("i");
  downloadButton.type = "button";
  downloadButton.setAttribute("aria-label", `${file.originalFileName} 다운로드`);
  downloadButton.dataset.tooltip = "다운로드";
  downloadIcon.setAttribute("data-lucide", "download");
  downloadIcon.setAttribute("aria-hidden", "true");
  downloadButton.append(downloadIcon);
  downloadButton.addEventListener("click", async () => {
    downloadButton.disabled = true;
    const downloadFrame = document.createElement("iframe");
    downloadFrame.hidden = true;
    downloadFrame.title = `${file.originalFileName} 다운로드`;
    document.body.append(downloadFrame);

    try {
      await ensureAccessToken();
      const originalUrl = messageFileUrl(message.messageId, file.fileOrder, "ORIGINAL");
      let downloadUrl = originalUrl;
      let response = await fetch(downloadUrl, {
        method: "GET",
        credentials: "include",
        headers: { Range: "bytes=0-0" }
      });
      await response.body?.cancel();

      if (response.status === 401) {
        await refreshAccessToken();
        downloadUrl = mediaRetryUrl(originalUrl);
        response = await fetch(downloadUrl, {
          method: "GET",
          credentials: "include",
          headers: { Range: "bytes=0-0" }
        });
        await response.body?.cancel();
      }

      if (!response.ok) {
        const errorMessage = response.status === 404
          ? "파일을 찾을 수 없습니다."
          : "파일을 다운로드하지 못했습니다.";
        throw new ApiError(errorMessage, response.status);
      }

      downloadFrame.src = downloadUrl;
      setTimeout(() => downloadFrame.remove(), 86_400_000);
    } catch (error) {
      downloadFrame.remove();
      handleError(error instanceof TypeError ? new ApiError("서버에 연결할 수 없습니다.") : error);
    } finally {
      downloadButton.disabled = false;
    }
  });

  item.append(fileIcon, copy, downloadButton);
  return item;
};

const createFileMessageContent = (message) => {
  const attachments = createElement("div", "cw-message-attachments");
  const imageFiles = message.chatEventFiles.filter((file) => file.fileCategory === "IMAGE");

  if (imageFiles.length) {
    attachments.append(createImageGallery(message, imageFiles));
  }

  message.chatEventFiles.forEach((file) => {
    if (file.fileCategory === "IMAGE") return;

    if (file.fileCategory === "VIDEO") {
      attachments.append(createVideoAttachment(message, file));
      return;
    }

    attachments.append(createFileAttachment(message, file));
  });

  return attachments;
};

const renderMessages = ({ scrollMode = MESSAGE_SCROLL_MODE.BOTTOM } = {}) => {
  const previousHeight = dom.messages.scrollHeight;
  const previousTop = dom.messages.scrollTop;
  const scrollAnchor = scrollMode === MESSAGE_SCROLL_MODE.BOTTOM
    ? null
    : captureMessageScrollAnchor();
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
    state.messageScrollPinned = scrollMode === MESSAGE_SCROLL_MODE.BOTTOM;
    return;
  }

  let previousMessageDateKey = null;

  state.messages.forEach((message) => {
    const currentMessageDateKey = messageDateKey(message.createdAt);
    if (currentMessageDateKey && currentMessageDateKey !== previousMessageDateKey) {
      dom.messages.append(createElement("div", "cw-system-message", formatMessageDate(message.createdAt)));
      previousMessageDateKey = currentMessageDateKey;
    }

    if (message.chatMessageType === "JOIN_TEXT" || message.chatMessageType === "LEAVE_TEXT") {
      const system = createElement("div", "cw-system-message", message.content);
      system.dataset.messageId = String(message.messageId);
      system.append(createElement("span", "cw-system-time", formatMessageTime(message.createdAt)));
      dom.messages.append(system);
      return;
    }

    const mine = message.senderId != null && message.senderId === state.me?.userId;
    const row = createElement("div", `cw-message-row${mine ? " mine" : ""}`);
    row.dataset.messageId = String(message.messageId);
    if (!mine) {
      const sender = {
        userId: message.senderId,
        username: message.senderName,
        profileImageKey: message.senderProfileImageKey
      };
      row.append(createProfileAvatarButton(sender));
    }

    const body = createElement("div", "cw-message-body");
    if (!mine) {
      body.append(createElement("span", "cw-message-sender", message.senderName || "알 수 없는 사용자"));
    }
    if (message.chatMessageType === "FILE" && message.chatEventFiles.length) {
      body.append(createFileMessageContent(message));
    } else {
      body.append(createElement("div", "cw-message", message.content));
    }

    const metadata = createElement("div", "cw-message-meta");
    const unreadCount = unreadCountForMessage(message);
    const unread = unreadCount > 0
      ? createElement("span", "cw-message-unread", String(unreadCount))
      : null;
    const time = createElement("span", "cw-message-time", formatMessageTime(message.createdAt));
    if (mine) {
      if (unread) metadata.append(unread);
      metadata.append(time);
    } else {
      metadata.append(time);
      if (unread) metadata.append(unread);
    }
    body.append(metadata);
    row.append(body);
    dom.messages.append(row);
  });

  state.messageScrollPinned = scrollMode === MESSAGE_SCROLL_MODE.BOTTOM;
  if (scrollMode === MESSAGE_SCROLL_MODE.BOTTOM) {
    maintainPinnedMessageScroll();
  } else {
    const fallbackTop = scrollMode === MESSAGE_SCROLL_MODE.PREPEND
      ? dom.messages.scrollHeight - previousHeight + previousTop
      : previousTop;
    restoreMessageScrollAnchor(scrollAnchor, fallbackTop);
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

const closeOriginalProfileImage = () => {
  const dialog = $("#cw-profile-image-dialog");
  dialog.hidden = true;
  const imageContainer = $("#cw-profile-original-image");
  imageContainer.replaceChildren();
  imageContainer.classList.remove("cw-profile-original-default");
  imageContainer.setAttribute("aria-label", "프로필 원본 이미지");
};

const openOriginalProfileImage = (profileImageKey, username) => {
  const imageContainer = $("#cw-profile-original-image");
  const displayName = username || "알 수 없는 사용자";
  imageContainer.replaceChildren();

  const showDefaultImage = () => {
    imageContainer.replaceChildren();
    imageContainer.classList.add("cw-profile-original-default");
    imageContainer.setAttribute("aria-label", `${displayName} 기본 프로필 이미지`);
    const icon = createElement("i", "cw-profile-original-default-icon");
    icon.setAttribute("data-lucide", "user-round");
    icon.setAttribute("aria-hidden", "true");
    imageContainer.append(icon);
    renderIcons();
  };

  if (profileImageKey) {
    imageContainer.classList.remove("cw-profile-original-default");
    imageContainer.setAttribute("aria-label", `${displayName} 프로필 원본 이미지`);
    const image = createElement("img", "cw-profile-original-image-content");
    image.src = profileImageUrl(profileImageKey, "image");
    image.alt = `${displayName} 프로필 원본 이미지`;
    image.addEventListener("error", showDefaultImage, { once: true });
    imageContainer.append(image);
  } else {
    showDefaultImage();
  }

  $("#cw-profile-image-dialog").hidden = false;
};

const closeDialogs = () => {
  const shouldRefreshMembers = state.refreshMembersOnProfileClose
    && !$("#cw-friend-profile-dialog").hidden
    && !dom.detailPanel.hidden;

  closeMessageMediaViewer();
  $$(".cw-dialog-backdrop").forEach((dialog) => {
    if (dialog !== dom.messageDialog) dialog.hidden = true;
  });
  closeOriginalProfileImage();
  state.selectedProfileUser = null;
  state.refreshMembersOnProfileClose = false;
  dom.namePopover.hidden = true;
  $("#cw-name-button").setAttribute("aria-expanded", "false");

  if (shouldRefreshMembers) openDetails();
};

const setSubmitting = (form, submitting) => {
  [...form.elements].forEach((element) => { element.disabled = submitting; });
};

const setFileUploading = (uploading) => {
  dom.fileButton.disabled = uploading;
  dom.fileInput.disabled = uploading;
  dom.fileButton.setAttribute("aria-busy", String(uploading));
  dom.fileButton.setAttribute("aria-label", uploading ? "파일 전송 중" : "파일 첨부");
  dom.fileButton.dataset.tooltip = uploading ? "파일 전송 중" : "파일 첨부";

  const icon = createElement("i");
  icon.setAttribute("data-lucide", uploading ? "loader-circle" : "paperclip");
  icon.setAttribute("aria-hidden", "true");
  dom.fileButton.replaceChildren(icon);
  renderIcons();
};

const isAuthenticationError = (error) => {
  const code = error?.code;
  return Number(error?.status) === 401
    || (typeof code === "string" && (/^J00[1-8]$/.test(code) || code === "W001"));
};

const showLoginRequired = () => {
  state.authenticationFailureHandled = true;
  cancelPendingRoomOpens();
  Promise.resolve(socket.disconnect()).catch(() => {});
  showMessage("로그인이 필요합니다.", redirectToLogin);
};

const handleAuthenticationFailure = () => {
  if (state.authenticationFailureHandled) return;
  showLoginRequired();
};

const handleOtherTabLogin = () => {
  if (state.sessionInvalidated) return;
  state.sessionInvalidated = true;
  state.authenticationFailureHandled = true;
  invalidateSession();

  clearTimeout(state.readTimer);
  clearTimeout(state.membershipRefreshTimer);
  state.readTimer = null;
  state.membershipRefreshTimer = null;
  state.roomAbortController?.abort();
  state.roomAbortController = null;
  state.messageScrollPinned = false;
  cancelNewMessageNotice();
  state.roomLoadVersion += 1;
  state.membershipRefreshVersion += 1;
  state.detailLoadVersion += 1;
  state.me = null;
  state.friends = [];
  state.rooms.clear();
  state.selectedRoomId = null;
  state.messages = [];
  state.readStates.clear();
  state.members = [];
  state.selectedProfileUser = null;
  state.refreshMembersOnProfileClose = false;
  state.editTarget = null;
  state.roomListSyncing = false;
  state.roomListSyncPromise = null;
  state.pendingRoomListEvents = [];
  state.userMetadataSyncing = false;
  state.pendingUserMetadataEvents = [];
  cancelPendingRoomOpens();
  state.roomSyncing = false;
  state.pendingRoomEvents = [];
  state.hasOlderMessages = false;
  state.loadingOlderMessages = false;
  state.hasConnected = false;

  closeDetails();
  closeDialogs();
  Promise.resolve(socket.disconnect()).catch(() => {});
  showMessage("다른 탭에서 로그인되어 로그아웃되었습니다.", redirectToLogin);
};

const handleError = (error) => {
  if (error?.name === "AbortError") return;
  if (isAuthenticationError(error)) {
    handleAuthenticationFailure();
    return;
  }
  showMessage(error?.message || String(error));
};

const redirectToLogin = () => {
  cancelPendingRoomOpens();
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

const resolvePendingRoomOpen = (roomId) => {
  const pending = state.pendingRoomOpens.get(roomId);
  if (!pending) return;

  clearTimeout(pending.timeoutId);
  state.pendingRoomOpens.delete(roomId);
  pending.resolve();
};

const resolveAvailableRoomOpens = () => {
  [...state.pendingRoomOpens.keys()].forEach((roomId) => {
    if (state.rooms.has(roomId)) resolvePendingRoomOpen(roomId);
  });
};

const cancelPendingRoomOpens = () => {
  state.pendingRoomOpens.forEach((pending) => {
    clearTimeout(pending.timeoutId);
    pending.reject(new DOMException("채팅방 입장 대기가 취소되었습니다.", "AbortError"));
  });
  state.pendingRoomOpens.clear();
};

const waitForRoom = (roomId) => {
  if (state.rooms.has(roomId)) return Promise.resolve();

  const existing = state.pendingRoomOpens.get(roomId);
  if (existing) return existing.promise;

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timeoutId = setTimeout(() => {
    state.pendingRoomOpens.delete(roomId);
    rejectPromise(new Error("채팅방은 생성되었지만 정보를 받지 못했습니다. 새로고침 후 확인해주세요."));
  }, CREATED_ROOM_EVENT_TIMEOUT_MS);

  state.pendingRoomOpens.set(roomId, {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    timeoutId
  });
  return promise;
};

const openCreatedRoom = async (value) => {
  const roomId = toNumber(value);
  if (roomId == null) throw new Error("채팅방 생성 응답이 올바르지 않습니다.");

  closeDialogs();
  selectSidebarTab("chats");
  await waitForRoom(roomId);
  await openRoom(roomId);
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
      resolveAvailableRoomOpens();
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
      replayPendingUserMetadataEvents();
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

const closeDetails = () => {
  if (!dom.detailPanel.hidden) state.detailLoadVersion += 1;
  dom.detailPanel.hidden = true;
  $("#cw-detail-button").setAttribute("aria-expanded", "false");
};

const closeActiveRoom = () => {
  if (state.selectedRoomId == null) return;

  clearTimeout(state.readTimer);
  clearTimeout(state.membershipRefreshTimer);
  state.readTimer = null;
  state.membershipRefreshTimer = null;
  state.roomAbortController?.abort();
  state.roomAbortController = null;
  state.messageScrollPinned = false;
  cancelNewMessageNotice();
  state.roomLoadVersion += 1;
  state.membershipRefreshVersion += 1;
  state.selectedRoomId = null;
  state.messages = [];
  state.readStates.clear();
  state.members = [];
  state.roomSyncing = false;
  state.pendingRoomEvents = [];
  state.hasOlderMessages = false;
  state.loadingOlderMessages = false;
  socket.unsubscribeRoom();
  closeMessageMediaViewer();
  closeDetails();
  dom.namePopover.hidden = true;
  renderRoomList();
  renderRoomHeader();
};

const removeRoom = (roomId) => {
  state.rooms.delete(roomId);
  if (state.selectedRoomId === roomId) {
    closeActiveRoom();
  }
};

const applyRoomListEvent = (event, snapshotRoom = null) => {
  const roomId = toNumber(event.roomId);
  if (roomId == null) return;
  const includedInSnapshot = eventWasIncludedInSnapshot(event, snapshotRoom);

  if (event.eventType === "ROOM_ADDED") {
    if (!includedInSnapshot) state.rooms.set(roomId, normalizeRoom(event));
    if (state.rooms.has(roomId)) resolvePendingRoomOpen(roomId);
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
  if (state.sessionInvalidated) return;
  if (state.roomListSyncing) {
    state.pendingRoomListEvents.push(event);
    return;
  }
  applyRoomListEvent(event);
};

const applyRoomEvent = (event, snapshotMessageId = null, { allowNewMessageNotice = true } = {}) => {
  if (toNumber(event.roomId) !== state.selectedRoomId) return;

  if (event.chatEventType === "MESSAGE_SENT") {
    const message = normalizeMessage(event);
    if (snapshotMessageId != null && message.messageId <= snapshotMessageId) return;
    if (!state.messages.some((candidate) => candidate.messageId === message.messageId)) {
      const sentByCurrentUser = message.senderId != null && message.senderId === state.me?.userId;
      const scrollMode = sentByCurrentUser
        ? MESSAGE_SCROLL_MODE.BOTTOM
        : currentMessageScrollMode();
      state.messages.push(message);
      state.messages.sort((left, right) => left.messageId - right.messageId);
      renderMessages({ scrollMode });
      if (sentByCurrentUser) {
        cancelNewMessageNotice();
      } else if (allowNewMessageNotice) {
        scheduleNewMessageVisibilityCheck(message);
      }
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
      renderMessages({ scrollMode: currentMessageScrollMode() });
    }
  }
};

const handleRoomEvent = (event) => {
  if (state.sessionInvalidated) return;
  if (state.roomSyncing && toNumber(event.roomId) === state.selectedRoomId) {
    state.pendingRoomEvents.push(event);
    return;
  }
  applyRoomEvent(event);
};

const patchUserMetadata = (target, event, usernameField, profileImageKeyField) => {
  if (event.userMetadataEventType === "USERNAME_UPDATED") {
    if (typeof event.username !== "string" || target[usernameField] === event.username) return false;
    target[usernameField] = event.username;
    return true;
  }

  if (event.userMetadataEventType === "USER_PROFILE_IMAGE_UPDATE") {
    if (!Object.prototype.hasOwnProperty.call(event, "userProfileImageKey")) return false;
    const nextProfileImageKey = event.userProfileImageKey ?? null;
    if (target[profileImageKeyField] === nextProfileImageKey) return false;
    target[profileImageKeyField] = nextProfileImageKey;
    return true;
  }

  return false;
};

const applyUserMetadataEvent = (event) => {
  const userId = toNumber(event.userId);
  if (userId == null || userId === state.me?.userId) return;

  let roomsChanged = false;
  let selectedRoomChanged = false;
  state.rooms.forEach((room) => {
    let roomChanged = false;
    room.previewUsers.forEach((previewUser) => {
      if (toNumber(previewUser.userId) !== userId) return;
      roomChanged = patchUserMetadata(previewUser, event, "username", "profileImageKey") || roomChanged;
    });
    roomsChanged = roomChanged || roomsChanged;
    if (roomChanged && room.roomId === state.selectedRoomId) selectedRoomChanged = true;
  });

  let messagesChanged = false;
  state.messages.forEach((message) => {
    if (toNumber(message.senderId) !== userId) return;
    messagesChanged = patchUserMetadata(
      message,
      event,
      "senderName",
      "senderProfileImageKey"
    ) || messagesChanged;
  });

  let membersChanged = false;
  state.members.forEach((member) => {
    if (toNumber(member.userId) !== userId) return;
    membersChanged = patchUserMetadata(member, event, "username", "profileImageKey") || membersChanged;
  });
  let friendsChanged = false;
  state.friends.forEach((friend) => {
    if (toNumber(friend.friendId) !== userId) return;
    friendsChanged = patchUserMetadata(friend, event, "friendUsername", "profileImageKey") || friendsChanged;
  });
  const selectedProfileChanged = state.selectedProfileUser?.userId === userId
    && patchUserMetadata(state.selectedProfileUser, event, "username", "profileImageKey");

  if (roomsChanged) renderRoomList();
  if (selectedRoomChanged) renderRoomHeader();
  if (messagesChanged) renderMessages({ scrollMode: currentMessageScrollMode() });
  if (membersChanged && !dom.detailPanel.hidden) renderMembers();
  if (friendsChanged) renderFriendList();

  if (selectedProfileChanged && !$("#cw-friend-profile-dialog").hidden) {
    setAvatar(
      $("#cw-friend-profile-avatar"),
      state.selectedProfileUser.username,
      state.selectedProfileUser.profileImageKey
    );
    $("#cw-friend-profile-name").textContent = state.selectedProfileUser.username;
    renderUserProfileAction();
    if (!$("#cw-profile-image-dialog").hidden) {
      openOriginalProfileImage(
        state.selectedProfileUser.profileImageKey,
        state.selectedProfileUser.username
      );
    }
    renderIcons();
  }
};

const replayPendingUserMetadataEvents = () => {
  if (state.userMetadataSyncing || state.roomListSyncing || state.roomSyncing) return;

  const queuedEvents = state.pendingUserMetadataEvents;
  state.pendingUserMetadataEvents = [];
  queuedEvents.forEach(applyUserMetadataEvent);
};

const handleUserMetadataEvent = (event) => {
  if (state.sessionInvalidated) return;
  if (state.userMetadataSyncing || state.roomListSyncing || state.roomSyncing) {
    state.pendingUserMetadataEvents.push(event);
    return;
  }
  applyUserMetadataEvent(event);
};

const loadRoomSnapshot = async (roomId, { preservePendingEvents = false } = {}) => {
  state.roomAbortController?.abort();
  state.roomAbortController = new AbortController();
  const version = ++state.roomLoadVersion;
  state.roomSyncing = true;
  cancelNewMessageNotice();
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
    queuedEvents.forEach((event) => applyRoomEvent(
      event,
      snapshotMessageId,
      { allowNewMessageNotice: false }
    ));
    renderMessages({ scrollMode: MESSAGE_SCROLL_MODE.BOTTOM });
    scheduleRead();
  } finally {
    if (version === state.roomLoadVersion) state.roomSyncing = false;
    replayPendingUserMetadataEvents();
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
  state.messageScrollPinned = true;
  cancelNewMessageNotice();
  state.readStates.clear();
  state.members = [];
  closeDetails();
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
    renderMessages({ scrollMode: MESSAGE_SCROLL_MODE.PREPEND });
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

const canMarkMessagesAsRead = () =>
  document.visibilityState === "visible" && document.hasFocus();

const cancelScheduledRead = () => {
  clearTimeout(state.readTimer);
  state.readTimer = null;
};

const scheduleRead = () => {
  cancelScheduledRead();
  const roomId = state.selectedRoomId;
  const latestMessageId = state.messages.at(-1)?.messageId;
  if (!roomId || latestMessageId == null || !canMarkMessagesAsRead()) return;

  state.readTimer = setTimeout(() => {
    state.readTimer = null;
    if (state.selectedRoomId !== roomId || !canMarkMessagesAsRead()) return;
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
  renderMessages({ scrollMode: currentMessageScrollMode() });
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

const findFriendByUserId = (userId) =>
  state.friends.find((friend) => friend.friendId === userId) ?? null;

const renderUserProfileAction = () => {
  const user = state.selectedProfileUser;
  const actionButton = $("#cw-friend-profile-chat");
  if (!user) return;

  actionButton.hidden = user.userId == null || user.userId === state.me?.userId;
  actionButton.textContent = findFriendByUserId(user.userId) ? "채팅하기" : "친구 추가";
};

const openUserProfile = (user) => {
  const userId = toNumber(user.userId ?? user.friendId);

  closeDialogs();
  state.refreshMembersOnProfileClose = false;
  const friend = findFriendByUserId(userId);
  state.selectedProfileUser = {
    userId,
    username: friend?.friendUsername ?? user.username ?? user.friendUsername ?? "알 수 없는 사용자",
    profileImageKey: friend?.profileImageKey ?? user.profileImageKey ?? null
  };

  setAvatar(
    $("#cw-friend-profile-avatar"),
    state.selectedProfileUser.username,
    state.selectedProfileUser.profileImageKey
  );
  $("#cw-friend-profile-name").textContent = state.selectedProfileUser.username;
  renderUserProfileAction();
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
    const friendAction = createElement("span", "cw-member-friend-action");
    if (member.canAddFriend) {
      const addFriendButton = createElement("button", "btn btn-ghost cw-icon-button");
      const addFriendIcon = createElement("i");
      addFriendButton.type = "button";
      addFriendButton.setAttribute("aria-label", `${member.username} 친구 추가`);
      addFriendButton.dataset.tooltip = "친구 추가";
      addFriendIcon.dataset.lucide = "user-plus";
      addFriendIcon.setAttribute("aria-hidden", "true");
      addFriendButton.append(addFriendIcon);
      addFriendButton.addEventListener("click", async () => {
        addFriendButton.disabled = true;
        try {
          await api.addFriend(member.username);
          await loadFriends();
          member.canAddFriend = false;
          renderMembers();
        } catch (error) {
          addFriendButton.disabled = false;
          handleError(error);
        }
      });
      friendAction.append(addFriendButton);
    }
    row.append(
      createProfileAvatarButton(member),
      createElement("span", "cw-member-name", member.username),
      friendAction,
      createElement("span", "cw-member-role text-small text-muted", member.chatRoomUserRole)
    );
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
  $("#cw-detail-button").setAttribute("aria-expanded", "true");
  dom.memberList.replaceChildren(createElement("div", "cw-list-state", "참여자를 불러오는 중입니다."));
  try {
    const members = await api.getRoomMembers(roomId);
    if (state.selectedRoomId !== roomId || state.detailLoadVersion !== version || dom.detailPanel.hidden) return;
    state.members = members;
    renderMembers();
  } catch (error) {
    if (state.selectedRoomId !== roomId || state.detailLoadVersion !== version) return;
    closeDetails();
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
  closeDetails();
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
  if (state.sessionInvalidated) return;
  state.userMetadataSyncing = true;
  state.pendingUserMetadataEvents = [];
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
  } finally {
    state.userMetadataSyncing = false;
    replayPendingUserMetadataEvents();
  }
};

const socket = new ChatSocket({
  onConnected: handleSocketConnected,
  onListEvent: handleRoomListEvent,
  onRoomEvent: handleRoomEvent,
  onUserMetadataEvent: handleUserMetadataEvent,
  onError: (error) => {
    if (!error?.transient) handleError(error);
  },
  onAuthFailure: handleAuthenticationFailure
});

const bindEvents = () => {
  window.addEventListener("focus", scheduleRead);
  window.addEventListener("blur", cancelScheduledRead);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleRead();
    } else {
      cancelScheduledRead();
    }
  });

  window.addEventListener("pageshow", (event) => {
    if (!getAccessToken() && (event.persisted || !state.authenticationFailureHandled)) {
      showLoginRequired();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.storageArea === localStorage && event.key === LOGIN_EVENT_KEY && event.newValue) {
      handleOtherTabLogin();
    }
  });

  const releasePinnedMessageScroll = () => {
    state.messageScrollPinned = false;
  };
  dom.messages.addEventListener("wheel", releasePinnedMessageScroll, { passive: true });
  dom.messages.addEventListener("touchstart", releasePinnedMessageScroll, { passive: true });
  dom.messages.addEventListener("pointerdown", releasePinnedMessageScroll);
  dom.messages.addEventListener("scroll", () => {
    if (messageScrollFrame != null) return;
    messageScrollFrame = requestAnimationFrame(() => {
      messageScrollFrame = null;
      state.messageScrollPinned = isMessageListAtBottom();
      if (state.newMessageNotice && isMessageVisible(state.newMessageNotice.messageId)) {
        hideNewMessageNotice();
      }
    });
  }, { passive: true });
  dom.newMessageNotice.addEventListener("click", () => {
    cancelNewMessageNotice();
    state.messageScrollPinned = true;
    maintainPinnedMessageScroll();
  });

  Object.entries(sidebarTabs).forEach(([tab, button]) => button.addEventListener("click", async () => {
    selectSidebarTab(tab);
    if (tab !== "friends") return;

    try {
      await loadFriends();
    } catch (error) {
      handleError(error);
    }
  }));
  dom.newChatButton.addEventListener("click", openNewChatDialog);
  dom.addFriendButton.addEventListener("click", () => {
    closeDialogs();
    $("#cw-friend-add-form").reset();
    $("#cw-friend-add-dialog").hidden = false;
    $("#cw-friend-username").focus();
  });
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", closeDialogs));
  $("[data-close-profile-image]").addEventListener("click", closeOriginalProfileImage);
  $("#cw-message-media-close").addEventListener("click", closeMessageMediaViewer);
  $("#cw-message-media-previous").addEventListener("click", () => moveMessageMediaViewer(-1));
  $("#cw-message-media-next").addEventListener("click", () => moveMessageMediaViewer(1));
  $$(".cw-dialog-backdrop").forEach((backdrop) => {
    if (
      backdrop === dom.messageDialog
      || backdrop.id === "cw-profile-image-dialog"
      || backdrop.id === "cw-message-media-dialog"
    ) return;
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialogs();
    });
  });
  $("#cw-profile-image-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeOriginalProfileImage();
  });
  $("#cw-message-media-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeMessageMediaViewer();
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
    $("#cw-group-name-field").hidden = count === 0;
  });

  $("#cw-new-chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const friendIds = $$(".cw-new-chat-check:checked").map((checkbox) => Number(checkbox.value));
    if (!friendIds.length) return;
    setSubmitting(form, true);
    try {
      const result = await api.createGroupRoom(friendIds, $("#cw-group-name").value.trim());
      await openCreatedRoom(result.chatRoomId);
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(form, false);
    }
  });

  $("#cw-friend-profile-chat").addEventListener("click", async (event) => {
    const user = state.selectedProfileUser;
    if (!user) return;

    const actionButton = event.currentTarget;
    actionButton.disabled = true;
    try {
      if (findFriendByUserId(user.userId)) {
        const result = await api.createDirectRoom(user.userId);
        await openCreatedRoom(result.chatRoomId);
      } else {
        await api.addFriend(user.username);
        await loadFriends();
        state.refreshMembersOnProfileClose = true;
        renderUserProfileAction();
      }
    } catch (error) {
      handleError(error);
    } finally {
      actionButton.disabled = false;
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
    closeDialogs();
    dom.namePopover.hidden = false;
    $("#cw-name-button").setAttribute("aria-expanded", "true");
  });
  $("#cw-name-close").addEventListener("click", closeDialogs);
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
  $("#cw-room-close").addEventListener("click", closeActiveRoom);
  $("#cw-detail-close").addEventListener("click", closeDetails);
  dom.activeRoom.addEventListener("click", (event) => {
    if (event.target.closest(".cw-room-header")) return;
    closeDetails();
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

  dom.fileButton.addEventListener("click", () => {
    if (state.selectedRoomId == null || dom.fileButton.disabled) return;
    dom.fileInput.click();
  });
  dom.fileInput.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    const files = [...(input.files || [])];
    const roomId = state.selectedRoomId;
    if (!files.length || roomId == null) {
      input.value = "";
      return;
    }

    setFileUploading(true);
    try {
      await api.sendMessageFiles(roomId, files);
    } catch (error) {
      handleError(error);
    } finally {
      input.value = "";
      setFileUploading(false);
    }
  });
  $("#cw-profile-image-button").addEventListener("click", () => $("#cw-profile-image-input").click());
  $("#cw-my-avatar").addEventListener("click", () => {
    openOriginalProfileImage($("#cw-my-avatar").dataset.profileImageKey, state.me?.username);
  });
  $("#cw-friend-profile-avatar").addEventListener("click", () => {
    openOriginalProfileImage(
      $("#cw-friend-profile-avatar").dataset.profileImageKey,
      state.selectedProfileUser?.username
    );
  });
  $("#cw-profile-image-input").addEventListener("change", async (event) => {
    const input = event.currentTarget;
    const profileImage = input.files?.[0];
    if (!profileImage) return;

    const button = $("#cw-profile-image-button");
    button.disabled = true;
    try {
      await api.updateProfileImage(profileImage);
      state.me = await api.getMe();
      state.me.userId = toNumber(state.me.userId);
      renderCurrentUser();
      showMessage("프로필 이미지를 변경했습니다.");
    } catch (error) {
      handleError(error);
    } finally {
      input.value = "";
      button.disabled = false;
    }
  });
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
    if (!$("#cw-message-media-dialog").hidden) {
      if (event.key === "Tab") {
        const dialog = $("#cw-message-media-dialog");
        const focusableElements = [...dialog.querySelectorAll(
          "button:not([hidden]):not(:disabled), video[controls]"
        )].filter((element) => element.offsetParent !== null);
        const firstElement = focusableElements[0];
        const lastElement = focusableElements.at(-1);

        if (event.shiftKey && (document.activeElement === firstElement || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          lastElement?.focus();
        } else if (!event.shiftKey && (document.activeElement === lastElement || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          firstElement?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        closeMessageMediaViewer();
        return;
      }
      if (event.key === "ArrowLeft") {
        moveMessageMediaViewer(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        moveMessageMediaViewer(1);
        return;
      }
    }

    if (event.key !== "Escape") return;
    if (!$("#cw-profile-image-dialog").hidden) {
      closeOriginalProfileImage();
      return;
    }
    closeDialogs();
  });
};

const bootstrap = async () => {
  bindEvents();
  if (document.documentElement.classList.contains("mobile-layout")) {
    $("#cw-room-close").setAttribute("aria-label", "채팅방 목록으로 돌아가기");
    $("#cw-room-close").dataset.tooltip = "채팅방 목록으로 돌아가기";
  }
  if (window.lucide) window.lucide.createIcons({ attrs: { width: 16, height: 16 } });

  if (!getAccessToken()) {
    showLoginRequired();
    return;
  }

  try {
    state.me = await api.getMe();
    state.me.userId = toNumber(state.me.userId);
    renderCurrentUser();
    socket.connect();
  } catch (error) {
    handleError(error);
  }
};

bootstrap();
