(() => {
      const root = document.getElementById('chat-layout-wireframe');
      const inviteButton = root.querySelector('#cw-invite-button');
      const nameButton = root.querySelector('#cw-name-button');
      const detailButton = root.querySelector('#cw-detail-button');
      const namePopover = root.querySelector('#cw-name-popover');
      const detailPanel = root.querySelector('#cw-detail-panel');
      const editDialog = root.querySelector('#cw-edit-dialog');
      const inviteDialog = root.querySelector('#cw-invite-dialog');
      const friendSearchDialog = root.querySelector('#cw-friend-search-dialog');
      const newChatDialog = root.querySelector('#cw-new-chat-dialog');
      const friendProfileDialog = root.querySelector('#cw-friend-profile-dialog');
      const friendProfileAvatar = root.querySelector('#cw-friend-profile-avatar');
      const friendProfileName = root.querySelector('#cw-friend-profile-name');
      const newChatSubmit = root.querySelector('#cw-new-chat-submit');
      const editInput = root.querySelector('#cw-edit-input');
      const editDialogTitle = root.querySelector('#cw-edit-dialog-title');
      const editInputLabel = root.querySelector('#cw-edit-input-label');
      const sidebarTitle = root.querySelector('#cw-sidebar-title');
      const newChatButton = root.querySelector('#cw-new-chat-button');
      const addFriendButton = root.querySelector('#cw-add-friend-button');
      const sidebarViews = {
        friends: root.querySelector('#cw-friend-list-view'),
        chats: root.querySelector('#cw-chat-list-view'),
        settings: root.querySelector('#cw-settings-view')
      };
      const sidebarTabs = {
        friends: root.querySelector('#cw-friends-tab'),
        chats: root.querySelector('#cw-chats-tab'),
        settings: root.querySelector('#cw-settings-tab')
      };
      let editTarget = null;

      const setNameOpen = (open) => {
        namePopover.hidden = !open;
        nameButton.setAttribute('aria-expanded', String(open));
        if (open) setDetailOpen(false);
      };

      const setDetailOpen = (open) => {
        detailPanel.hidden = !open;
        detailButton.setAttribute('aria-expanded', String(open));
        if (open) {
          namePopover.hidden = true;
          nameButton.setAttribute('aria-expanded', 'false');
        }
      };

      const closeDialogs = () => {
        editDialog.hidden = true;
        inviteDialog.hidden = true;
        friendSearchDialog.hidden = true;
        newChatDialog.hidden = true;
        friendProfileDialog.hidden = true;
        inviteButton.setAttribute('aria-expanded', 'false');
      };

      const openEditDialog = (target) => {
        const isBase = target === 'base';
        editTarget = target;
        editDialogTitle.textContent = isBase ? '기본 이름 수정' : '내가 보는 이름 수정';
        editInputLabel.textContent = isBase ? '기본 이름' : '내가 보는 이름';
        editInput.value = root.querySelector(isBase ? '#cw-base-name-value' : '#cw-custom-name-value').textContent;
        editDialog.hidden = false;
        inviteDialog.hidden = true;
        editInput.focus();
      };

      const selectSidebarTab = (tab) => {
        Object.entries(sidebarViews).forEach(([key, view]) => {
          view.hidden = key !== tab;
        });
        Object.entries(sidebarTabs).forEach(([key, button]) => {
          const selected = key === tab;
          button.classList.toggle('is-selected', selected);
          button.setAttribute('aria-selected', String(selected));
        });
        sidebarTitle.textContent = tab === 'friends' ? '친구' : tab === 'settings' ? '설정' : '채팅';
        newChatButton.hidden = tab !== 'chats';
        addFriendButton.hidden = tab !== 'friends';
      };

      nameButton.addEventListener('click', () => setNameOpen(namePopover.hidden));
      detailButton.addEventListener('click', () => setDetailOpen(detailPanel.hidden));
      inviteButton.addEventListener('click', () => {
        const open = inviteDialog.hidden;
        closeDialogs();
        inviteDialog.hidden = !open;
        inviteButton.setAttribute('aria-expanded', String(open));
        if (open) setNameOpen(false);
      });
      root.querySelector('#cw-name-close').addEventListener('click', () => setNameOpen(false));
      root.querySelector('#cw-detail-close').addEventListener('click', () => setDetailOpen(false));
      root.querySelector('#cw-edit-base-name').addEventListener('click', () => openEditDialog('base'));
      root.querySelector('#cw-edit-custom-name').addEventListener('click', () => openEditDialog('custom'));
      root.querySelector('#cw-edit-dialog-close').addEventListener('click', closeDialogs);
      root.querySelector('#cw-edit-cancel').addEventListener('click', closeDialogs);
      root.querySelector('#cw-invite-dialog-close').addEventListener('click', closeDialogs);
      root.querySelector('#cw-invite-cancel').addEventListener('click', closeDialogs);
      root.querySelector('#cw-invite-submit').addEventListener('click', closeDialogs);
      root.querySelector('#cw-edit-save').addEventListener('click', () => {
        const value = editInput.value.trim();
        if (!value || !editTarget) return;
        root.querySelector(editTarget === 'base' ? '#cw-base-name-value' : '#cw-custom-name-value').textContent = value;
        if (editTarget === 'custom') {
          root.querySelector('.cw-room-name').textContent = value;
          root.querySelector('.cw-room-row.is-selected .cw-room-title').textContent = value;
          root.querySelector('#cw-display-name-setting').textContent = value;
        }
        closeDialogs();
        setNameOpen(false);
      });
      sidebarTabs.friends.addEventListener('click', () => selectSidebarTab('friends'));
      sidebarTabs.chats.addEventListener('click', () => selectSidebarTab('chats'));
      sidebarTabs.settings.addEventListener('click', () => selectSidebarTab('settings'));
      newChatButton.addEventListener('click', () => {
        closeDialogs();
        root.querySelectorAll('.cw-new-chat-check').forEach((checkbox) => {
          checkbox.checked = false;
        });
        newChatSubmit.disabled = true;
        newChatDialog.hidden = false;
      });
      addFriendButton.addEventListener('click', () => {
        closeDialogs();
        friendSearchDialog.hidden = false;
        root.querySelector('#cw-friend-search-result').hidden = true;
        root.querySelector('#cw-friend-search-input').focus();
      });
      root.querySelector('#cw-friend-search-close').addEventListener('click', closeDialogs);
      root.querySelector('#cw-friend-search-submit').addEventListener('click', () => {
        root.querySelector('#cw-friend-search-result').hidden = false;
      });
      root.querySelector('#cw-new-chat-close').addEventListener('click', closeDialogs);
      root.querySelector('#cw-new-chat-cancel').addEventListener('click', closeDialogs);
      newChatSubmit.addEventListener('click', closeDialogs);
      root.querySelectorAll('.cw-new-chat-check').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          newChatSubmit.disabled = !root.querySelector('.cw-new-chat-check:checked');
        });
      });
      root.querySelector('#cw-friend-profile-close').addEventListener('click', closeDialogs);
      root.querySelector('#cw-friend-profile-chat').addEventListener('click', () => {
        closeDialogs();
        selectSidebarTab('chats');
      });
      root.querySelectorAll('#cw-friend-list-view .cw-friend-row').forEach((friendRow) => {
        friendRow.addEventListener('click', () => {
          closeDialogs();
          friendProfileAvatar.textContent = friendRow.dataset.friendInitial;
          friendProfileName.textContent = friendRow.dataset.friendName;
          friendProfileDialog.hidden = false;
        });
      });

      root.querySelectorAll('.cw-room-row').forEach((row) => {
        row.addEventListener('click', () => {
          root.querySelectorAll('.cw-room-row').forEach((candidate) => {
            const selected = candidate === row;
            candidate.classList.toggle('is-selected', selected);
            candidate.setAttribute('aria-pressed', String(selected));
          });
        });
      });
    })();

    if (window.lucide) {
      window.lucide.createIcons({ attrs: { width: 16, height: 16 } });
    }
